import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDnsAnswer, assessTcpDns } from './security-local-dns.mjs';
const question = Buffer.from('076578616d706c6503636f6d0000010001', 'hex');
const options = { id: 0x7777, question, expectedAddresses: ['11.0.0.1'] };
function answer() {
  return Buffer.concat([Buffer.from('777781800001000100000000', 'hex'), question,
    Buffer.from('c00c000100010000003c00045db8d822', 'hex')]); // 93.184.216.34
}

test('real TCP DNS answer remains a bypass when offline UDP returned a synthetic route', () => {
  const reply = parseDnsAnswer(answer(), options);
  assert.equal(reply.validResponse, true);
  assert.equal(reply.answered, true);
  assert.equal(reply.expectedAddressMatched, false);
  assert.deepEqual(reply.addresses, ['93.184.216.34']);
  assert.equal(assessTcpDns(reply, reply), 'bypass');
});

test('forged, wrong-question, wrong-code and truncated TCP DNS packets never establish denial', () => {
  const packets = [Buffer.alloc(0), answer().subarray(0, -1)];
  for (const [offset, value] of [[0, 0], [2, 1], [3, 3], [12, 6]]) {
    const packet = answer(); packet[offset] = value; packets.push(packet);
  }
  const online = parseDnsAnswer(answer(), options);
  for (const packet of packets) {
    const reply = parseDnsAnswer(packet, options);
    assert.equal(reply.answered, false);
    assert.equal(reply.validResponse, false);
    assert.equal(assessTcpDns(online, reply), 'indeterminate');
  }
});

test('denial requires a valid online response and no offline protocol bytes', () => {
  const online = parseDnsAnswer(answer(), options);
  assert.equal(assessTcpDns(online, { answered: false, responseReceived: false, receivedBytes: 0 }), 'denied');
  assert.equal(assessTcpDns(online, { answered: false, receivedBytes: 1 }), 'indeterminate');
  assert.equal(assessTcpDns({ answered: false }, { answered: false }), 'indeterminate');
  const empty = answer().subarray(0, 12 + question.length); empty.writeUInt16BE(0, 6);
  const reply = parseDnsAnswer(empty, options);
  assert.equal(reply.validResponse, true);
  assert.equal(reply.answered, false);
  assert.equal(assessTcpDns(online, reply), 'indeterminate');
});
