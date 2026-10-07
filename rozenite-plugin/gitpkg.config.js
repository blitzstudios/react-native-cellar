// Tags without the npm scope: `rozenite-plugin-cellar-v1.0.12-gitpkg`. gitpkg only reads a config exported as a function.
module.exports = () => ({
  getTagName: (pkg) => `${pkg.name.replace(/^@[^/]+\//, '')}-v${pkg.version}-gitpkg`,
});
