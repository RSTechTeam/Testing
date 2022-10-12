/** @fileoverview Syncs Bill.com Bill Line Item data into Airtable. */

import {Base} from '../common/airtable.js';
import {filter} from '../common/bill_com.js';
import {getYyyyMmDd, PRIMARY_ORG} from '../common/utils.js';

/** Bill.com Bill Approval Statuses. */
const approvalStatuses = new Map([
  ['0', 'Unassigned'],
  ['1', 'Assigned'],
  ['4', 'Approving'],
  ['3', 'Approved'],
  ['5', 'Denied'],
]);

/** Bill.com Bill Payment Statuses. */
const paymentStatuses = new Map([
  ['1', 'Open'],
  ['4', 'Scheduled'],
  ['0', 'Paid In Full'],
  ['2', 'Partial Payment'],
]);

/** The Bill.com API connection. */
let billComApi;

/**
 * @param {string} entity
 * @param {func(!Object<string, *>): *} dataFunc
 * @return {!Promise<!Map<string, *>>}
 */
 async function getEntityData(entity, dataFunc) {
  const entities = await billComApi.listActive(entity);
  const data = new Map();
  for (const e of entities) {
    data.set(e.id, dataFunc(e));
  }
  return data;
 }

/**
 * @param {string} entity
 * @return {!Promise<!Map<string, string>>}
 */
function getNames(entity) {
  return getEntityData(entity, e => e.name);
}

/**
 * @param {string} entity
 * @return {string}
 */
function billComIdFieldName(entity) {
  return `${PRIMARY_ORG} Bill.com ${entity} ID`;
}

/**
 * @param {!Api} api
 * @param {!Base=} billComIntegrationBase
 * @return {!Promise<undefined>}
 */
export async function main(api, billComIntegrationBase = new Base()) {
  billComApi = api;

  const BILL_REPORTING_TABLE = 'Bill Reporting';
  const merchantRegex =
      new RegExp(
          '(?<date>.+)\\n(?<name>.+)\\n(?<address>.+)\\n' +
              '(?<city>.+) \\| (?<state>.+) \\| (?<zip>.+)\\n' +
              '(?<description>.+)');

  // Initialize reference data.
  await billComApi.primaryOrgLogin();
  const sessionId = billComApi.getSessionId();
  const vendors =
      await getEntityData(
          'Vendor',
          v => ({
            name: v.name,
            address: v.address1,
            city: v.addressCity,
            state: v.addressState,
            zip: v.addressZip,
          }));
  const chartOfAccounts = await getNames('ChartOfAccount');
  const customers = await getNames('Customer');

  // Initialize sync changes.
  const bills =
      await billComApi.listActive('Bill');
  const changes = new Map();
  const primaryBillComId = billComIdFieldName('Line Item');
  for (const bill of bills) {
    
    const pages = await billComApi.dataCall('GetDocumentPages', {id: bill.id});
    const docs = [];
    for (let i = 1; i <= pages.documentPages.numPages; ++i) {
      docs.push({
        url:
          `https://api.bill.com/is/BillImageServlet?entityId=${bill.id}` +
              `&sessionId=${sessionId}&pageNumber=${i}`
      });
    }

    const submitterMatch =
        (bill.description || '').match(/Submitted by (.+) \(/);
    const vendor = vendors.get(bill.vendorId) || {};
    for (const item of bill.billLineItems) {
      const itemVendor = 
          (item.description.match(merchantRegex) || {}).groups || vendor;
      changes.set(
          item.id,
          {
            'Active': true,
            [primaryBillComId]: item.id,
            'Submitted By': submitterMatch == null ? null : submitterMatch[1],
            'Creation Date': getYyyyMmDd(item.createdTime),
            'Invoice Date': bill.invoiceDate,
            'Expense Date': itemVendor.date || bill.invoiceDate,
            [billComIdFieldName('Vendor')]: bill.vendorId,
            'Vendor Name': itemVendor.name,
            'Vendor Address': itemVendor.address,
            'Vendor City': itemVendor.city,
            'Vendor State': itemVendor.state,
            'Vendor Zip Code': itemVendor.zip,
            'Description': itemVendor.description || item.description,
            [billComIdFieldName('Chart of Account')]: item.chartOfAccountId,
            'Chart of Account': chartOfAccounts.get(item.chartOfAccountId),
            'Amount': item.amount,
            [billComIdFieldName('Customer')]: item.customerId,
            'Customer': customers.get(item.customerId),
            'Invoice ID': bill.invoiceNumber,
            'Supporting Documents': docs,
            'Approval Status': approvalStatuses.get(bill.approvalStatus),
            'Payment Status': paymentStatuses.get(bill.paymentStatus),
            [billComIdFieldName('Bill')]: bill.id,
          });
    }
  }

  // Update every existing table record based on the Bill.com data.
  const updates = [];
  await billComIntegrationBase.select(
      BILL_REPORTING_TABLE,
      '',
      (record) => {
        const id = record.get(primaryBillComId);
        updates.push({
          id: record.getId(), fields: changes.get(id) || {Active: false},
        });
        changes.delete(id);
      });
  await billComIntegrationBase.update(BILL_REPORTING_TABLE, updates);

  // Create new table records from new Bill.com data.
  const creates = [];
  for (const [id, data] of changes) {
    data[primaryBillComId] = id;
    creates.push({fields: data});
  }
  await billComIntegrationBase.create(BILL_REPORTING_TABLE, creates);
}