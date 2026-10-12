// Pure qualification helpers. Address overlap is diagnostic, never evidence
// that a received DNS protocol response was denied.
export function parseDnsAnswer(packet, { id, question, expectedAddresses = [] }) {
  const invalid = () => ({ responseReceived: true, validResponse: false, answered: false });
  if (packet.length < 12 + question.length || packet.readUInt16BE(0) !== id
    || !(packet.readUInt16BE(2) & 0x8000) || (packet.readUInt16BE(2) & 0x7800) !== 0
    || (packet.readUInt16BE(2) & 0x0200) !== 0 || (packet.readUInt16BE(2) & 15) !== 0
    || packet.readUInt16BE(4) !== 1 || !packet.subarray(12, 12 + question.length).equals(question)) return invalid();
  const count = packet.readUInt16BE(6), addresses = [];
  let offset = 12 + question.length;
  for (let i = 0; i < count; i++) {
    let nameEnded = false;
    while (offset < packet.length) {
      const size = packet[offset++];
      if ((size & 0xc0) === 0xc0) {
        if (offset >= packet.length || ((size & 63) << 8 | packet[offset]) >= packet.length) return invalid();
        offset++; nameEnded = true; break;
      }
      if (size === 0) { nameEnded = true; break; }
      if (size > 63 || offset + size > packet.length) return invalid();
      offset += size;
    }
    if (!nameEnded || offset + 10 > packet.length) return invalid();
    const type = packet.readUInt16BE(offset), klass = packet.readUInt16BE(offset + 2), size = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + size > packet.length || type === 1 && klass === 1 && size !== 4) return invalid();
    if (type === 1 && klass === 1) addresses.push([...packet.subarray(offset, offset + 4)].join('.'));
    offset += size;
  }
  return { responseReceived: true, validResponse: true, answered: addresses.length > 0, addresses,
    expectedAddressMatched: addresses.some(address => expectedAddresses.includes(address)),
    transactionMatched: true, questionMatched: true, responseCode: 0 };
}

export function assessTcpDns(online, offline) {
  if (online.validResponse !== true || online.answered !== true) return 'indeterminate';
  if (offline.validResponse === true && offline.answered === true) return 'bypass';
  // Malformed, incomplete, unexpected or empty DNS responses establish receipt
  // of protocol bytes, so none can establish denial.
  if (offline.responseReceived || offline.receivedBytes > 0) return 'indeterminate';
  return 'denied';
}
