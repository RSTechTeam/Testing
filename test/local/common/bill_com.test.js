import * as billCom from '../../../src/common/bill_com.js';

describe('apiCall', () => {

  const expectApiCallToThrow = (endpoint, appType, body, errorCode) => () => {
    const headers = {'Content-Type': `application/${appType}`};
    const apiCall = billCom.apiCall(endpoint, headers, body, true);
    return expect(apiCall).rejects.toThrow(new RegExp(`BDC_${errorCode}`));
  };

  const expectLoginToThrow = (appType, body, errorCode) => {
    return expectApiCallToThrow('Login', appType, body, errorCode);
  };

  const body = 'devKey=devKey&userName=userName&password=password&orgId=orgId';

  test('given no endpoint, throws', expectApiCallToThrow('', '', '', 1121));

  test('given missing params, throws', expectLoginToThrow('', '', 1108));

  test('given invalid params (wrong Content-Type), throws',
      expectLoginToThrow('', body, 1108));

  test('given invalid params (correct Content-Type, throws',
      expectLoginToThrow('x-www-form-urlencoded', body, 1129));
});

describe.each`
  given    | expected
  ${true}  | ${billCom.ActiveStatus.ACTIVE}
  ${false} | ${billCom.ActiveStatus.INACTIVE}
`('isActiveEnum', ({given, expected}) => {

  test(`given ${given}, returns ${expected}`,
      () => expect(billCom.isActiveEnum(given)).toBe(expected));
});

describe.each`
  givenName       | expectedName
  ${undefined}    | ${undefined}
  ${'First Last'} | ${'First%20Last'}
`('entityData', ({givenName, expectedName}) => {
  
  test(`given name "${givenName}", expect name "${expectedName}"`, () => {
    expect(billCom.entityData('Customer', {id: 1, name: givenName})).toEqual({
      obj: {entity: 'Customer', id: 1, name: expectedName}
    });
  });
});

test('filter creates API filter object', () => {
  expect(billCom.filter('field', 'op', 'value')).toEqual(
      {field: 'field', op: 'op', value: 'value'});
});
