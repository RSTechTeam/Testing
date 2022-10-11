/** @fileoverview Creates a Bill.com Bill based on a new Check Request. */

import fetch from 'node-fetch';
import {apiCall} from '../common/bill_com.js';
import {Base, PRIMARY_ORG_BILL_COM_ID} from '../common/airtable.js';
import {fetchError} from '../common/utils.js';
import {finalApproverUserId} from '../common/inputs.js';
import {FormData} from 'formdata-node';

/** The Bill.com Integration Airtable Base. */
let billComIntegrationBase;

/**
 * @param {string} table
 * @param {string} airtableId
 * @return {!Promise<string>}
 */
async function getBillComId(table, airtableId) {
  let billComId;
  await billComIntegrationBase.find(
      table,
      airtableId,
      (record) => billComId = record.get(PRIMARY_ORG_BILL_COM_ID));
  return billComId;
}

/**
 * @param {!Api} billComApi
 * @param {!Base=} airtableBase
 * @return {!Promise<undefined>}
 */
export async function main(billComApi, airtableBase = new Base()) {
  const CHECK_REQUESTS_TABLE = 'Check Requests';
  const NEW_VENDORS_TABLE = 'New Vendors';

  billComIntegrationBase = airtableBase;

  // Get new Check Requests.
  await billComApi.primaryOrgLogin();
  await billComIntegrationBase.selectAndUpdate(
      CHECK_REQUESTS_TABLE,
      'New',
      async (newCheckRequest) => {
        
        // Get the Vendor to pay for whom this request was submitted.
        let vendorId;
        if (newCheckRequest.get('New Vendor?')) {
          const newVendorId = newCheckRequest.get('New Vendor')[0];
          await billComIntegrationBase.find(
              NEW_VENDORS_TABLE,
              newVendorId,
              async (newVendor) => {
                vendorId =
                    await billComApi.create(
                        'Vendor',
                        {
                          name: newVendor.get('Name'),
                          address1: newVendor.get('Address Line 1'),
                          address2: newVendor.get('Address Line 2'),
                          addressCity: newVendor.get('City'),
                          addressState: newVendor.get('State'),
                          addressZip: newVendor.get('Zip Code').toString(),
                          addressCountry: newVendor.get('Country'),
                          email: newVendor.get('Email'),
                          phone: newVendor.get('Phone'),
                        });
              });
          await billComIntegrationBase.update(
              NEW_VENDORS_TABLE,
              [{
                id: newVendorId,
                fields: {[PRIMARY_ORG_BILL_COM_ID]: vendorId},
              }]);
        } else {
          vendorId =
              await getBillComId(
                  'Existing Vendors', newCheckRequest.get('Vendor')[0]);
        }

        // Get the Check Request Line Items.
        const billComLineItems = [];
        for (const itemId of newCheckRequest.get('Line Items')) {
          await billComIntegrationBase.find(
              'Check Request Line Items',
              itemId,
              async (item) => {
                const category = item.get('Category');
                let chartOfAccountId;
                if (category != null) {
                  chartOfAccountId =
                      await getBillComId('Chart of Accounts', category[0]);
                }

                const date = item.get('Item Expense Date');
                const description = item.get('Description');
                billComLineItems.push({
                  entity: 'BillLineItem',
                  amount: item.get('Amount'),
                  chartOfAccountId: chartOfAccountId,
                  customerId:
                    await getBillComId(
                        'Internal Customers', item.get('Project')[0]),
                  description:
                    date == undefined ?
                        description :
                        encodeURIComponent(
                            `${date}\n${item.get('Merchant Name')}\n` +
                                `${item.get('Merchant Address')}\n` +
                                `${item.get('Merchant City')} & ` +
                                `${item.get('Merchant State')} & ` +
                                `${item.get('Merchant Zip Code')}\n` +
                                `${description}`),
                });
              });
        }

        // Create Bill.com Bill based on Check Request.
        const requester = newCheckRequest.get('Requester Name');
        const invoiceId =
            newCheckRequest.get('Vendor Invoice ID') ||
                // Invoice number can currently be max 21 characters.
                // For default ID, take 15 from requester name
                // and 3 from unique part of Airtable Record ID,
                // with 3 to pretty divide these parts.
                `${requester.substring(0, 15)}` +
                    ` - ${newCheckRequest.getId().substring(3, 6)}`;
        const newBillId =
            await billComApi.create(
                'Bill',
                {
                  vendorId: vendorId,
                  invoiceNumber: invoiceId,
                  invoiceDate: newCheckRequest.get('Expense Date'),
                  dueDate: newCheckRequest.get('Due Date'),
                  description:
                    `Submitted by ${requester}` +
                        ` (${newCheckRequest.get('Requester Email')}).`,
                  billLineItems: billComLineItems,
                });

        // Set the Bill's approvers.
        const approverAirtableIds = newCheckRequest.get('Approvers') || [];
        const approverBillComIds =
            await Promise.all(
                approverAirtableIds.map((aid) => getBillComId('Users', aid)));
        approverBillComIds.push(finalApproverUserId());
        await billComApi.dataCall(
            'SetApprovers',
            {
              objectId: newBillId,
              entity: 'Bill',
              approvers: approverBillComIds,
            });

        // Upload the Supporting Documents.
        const data = new FormData();
        data.set('devKey', billComApi.getDevKey());
        data.set('sessionId', billComApi.getSessionId());
        const docs = newCheckRequest.get('Supporting Documents') || [];
        for (const doc of docs) {

          // Fetch the document.
          const response = await fetch(doc.url);
          if (!response.ok) {
            fetchError(response.status, doc.filename, response.statusText);
          }

          // Download it.
          const file = await response.blob();

          // Upload it.
          data.set('file', file, doc.filename);
          data.set(
              'data', JSON.stringify({id: newBillId, fileName: doc.filename}));

          await apiCall('UploadAttachment', {}, data);
        }

        return {
          'Active': true,
          'Vendor Invoice ID': invoiceId,
          [PRIMARY_ORG_BILL_COM_ID]: newBillId,
        };
      });
}
