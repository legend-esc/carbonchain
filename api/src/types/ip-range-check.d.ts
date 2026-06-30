declare module 'ip-range-check' {
  /**
   * Returns true if `ip` falls within any of the provided ranges.
   * `ranges` can be a single IP/CIDR string or an array of them.
   */
  function ipRangeCheck(ip: string, ranges: string | string[]): boolean;
  export default ipRangeCheck;
}
