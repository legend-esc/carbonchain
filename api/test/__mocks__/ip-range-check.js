// Manual mock for ip-range-check (bare CJS module).
// Used by Jest via moduleNameMapper so the package does not need to be
// resolvable at test time. Tests that care about IP filtering behaviour
// can override this with jest.mock() or jest.spyOn() as needed.
module.exports = function ipRangeCheck(_ip, _ranges) {
  return true;
};
