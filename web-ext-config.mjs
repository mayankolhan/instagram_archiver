/**
 * Config for Mozilla's `web-ext` tool.
 *   npx web-ext run      -> launch a temporary Firefox with the extension loaded
 *   npx web-ext build    -> produce a .zip in ./web-ext-artifacts
 *   npx web-ext sign     -> submit to AMO (unlisted) and get a signed .xpi
 */
export default {
  sourceDir: '.',
  ignoreFiles: ['README.md', 'web-ext-config.mjs', 'web-ext-artifacts', '*.md'],
  run: {
    startUrl: ['https://www.instagram.com/'],
  },
};
