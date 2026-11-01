// Jest manual mock for ip-range-check (bare CJS module).
// Mirrors the package's matching behaviour so tests that exercise allowlist
// filtering get real results instead of a blanket `true`.
const ipaddr = require('ipaddr.js');

function checkManyCidrs(addr, range) {
  if (typeof range === 'string') {
    return checkSingleCidr(addr, range);
  }
  if (typeof range === 'object' && range !== null) {
    for (let i = 0; i < range.length; i += 1) {
      if (checkSingleCidr(addr, range[i])) {
        return true;
      }
    }
  }
  return false;
}

function checkSingleCidr(addr, cidr) {
  try {
    const parsedAddr = ipaddr.process(addr);
    if (cidr.indexOf('/') === -1) {
      const parsedCidrAsIp = ipaddr.process(cidr);
      if (
        parsedAddr.kind() === 'ipv6' &&
        parsedCidrAsIp.kind() === 'ipv6'
      ) {
        return (
          parsedAddr.toNormalizedString() ===
          parsedCidrAsIp.toNormalizedString()
        );
      }
      return parsedAddr.toString() === parsedCidrAsIp.toString();
    }
    const parsedRange = ipaddr.parseCIDR(cidr);
    return parsedAddr.match(parsedRange);
  } catch (e) {
    return false;
  }
}

module.exports = checkManyCidrs;
