import { generateKeyPairSync, sign } from 'node:crypto';

const keys=generateKeyPairSync('ed25519');
export const TELNYX_TEST_ACCOUNT='6a9a7976-012e-45d2-9258-6f5dc68d861e';
export const TELNYX_TEST_CONNECTION='1568109700606592442';
export const TELNYX_TEST_CALL='v3:KBnLO0ZK3DhKM5s7bE9VluaSmKsOchKht_fUYvxcp8ysbmzCCtpkmA';
export const TELNYX_TEST_SIP='sip:receptionist@mainbrella.sip.telnyx.com';
export const TELNYX_TEST_BINDINGS={
  TELNYX_API_KEY:'telnyx-api-key-fixture',TELNYX_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'),
  TELNYX_ACCOUNT_SID:TELNYX_TEST_ACCOUNT,TELNYX_CONNECTION_ID:TELNYX_TEST_CONNECTION,TELNYX_PHONE_NUMBER:'+19362461010',
  TELNYX_PHONE_MICRO_USD_PER_MINUTE:'10000',
};
export function telnyxTestSignature(payload:string,timestamp=String(Math.floor(Date.now()/1000))) {
  return {'telnyx-timestamp':timestamp,'telnyx-signature-ed25519':sign(null,Buffer.from(`${timestamp}|${payload}`),keys.privateKey).toString('base64')};
}
