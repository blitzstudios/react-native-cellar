// Tags drop the npm scope, as every published tag has: `react-native-cellar-v1.2.22-gitpkg`.
module.exports = {
  getTagName: (pkg) => `${pkg.name.replace(/^@[^/]+\//, '')}-v${pkg.version}-gitpkg`,
};
