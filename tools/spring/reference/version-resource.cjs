const { readFileSync, writeFileSync } = require('node:fs');
const input = JSON.parse(readFileSync(`${__dirname}/build-input.json`, 'utf8'));
module.exports.register = function () {
  this.once('contentAggregated', ({ contentAggregate }) => {
    const properties = readFileSync(`${input.sourceRoot}/gradle.properties`, 'utf8');
    if (properties.split(/\r?\n/).filter(line => line.startsWith('version=')).join('\n') !== `version=${input.version}`) throw new Error('Source version mismatch');
    if (contentAggregate.length !== 1) throw new Error('Expected one Spring component');
    const batch = contentAggregate[0];
    if (batch.name !== 'framework' || batch.origins.length !== 1 || batch.origins[0].refhash !== input.commit || batch.origins[0].worktree) throw new Error('Unexpected Spring reference origin');
    batch.version = input.version;
    batch.asciidoc.attributes = { 'spring-version': input.version, ...batch.asciidoc.attributes };
    batch.asciidoc.attributes['spring-framework-code'] = `https://github.com/spring-projects/spring-framework/tree/${input.commit}`;
    delete batch.ext?.collector;
    writeFileSync(`${__dirname}/reference-input-evidence.json`, JSON.stringify({ version: input.version, commit: input.commit,
      files: batch.files.length, examples: batch.files.filter(file => file.path.startsWith('modules/ROOT/examples/docs-src/')).length }, null, 2), { flag: 'wx' });
  });
};
