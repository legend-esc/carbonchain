module.exports = {
  'api/**/*.ts': (filenames) =>
    `cd api && npx eslint --fix --max-warnings 0 ${filenames.map((f) => `"${f.replace(/^api\//, '')}"`).join(' ')}`,
  'frontend/**/*.ts': (filenames) =>
    `cd frontend && npx eslint --fix --max-warnings 0 ${filenames.map((f) => `"${f.replace(/^frontend\//, '')}"`).join(' ')}`,
  'contracts/**/*.rs': ['cd contracts && cargo fmt --check'],
};
