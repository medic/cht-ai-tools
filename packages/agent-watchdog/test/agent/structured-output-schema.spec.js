// The schema the Claude Code runtime receives (research.md R-2 addendum, S-4): no dialect or identifier keyword, and
// `definitions` in place of `$defs`, because the runtime's validator refused `$schema` 2020-12 on the first hosted run.
const fs = require('node:fs');
const path = require('node:path');
const { forStructuredOutput, toJsonSchemas } = require('../../src/agent/output-schema');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schema');

describe('agent/output-schema forStructuredOutput', () => {
  it('drops $schema and $id, renames $defs and rewrites every $ref, leaving the input untouched', () => {
    const { findings } = toJsonSchemas();
    const before = JSON.stringify(findings);
    expect(before).to.include('"$schema"').and.include('"$defs"').and.include('#/$defs/');
    const safe = forStructuredOutput(findings);
    const after = JSON.stringify(safe);
    expect(after).to.not.include('"$schema"');
    expect(after).to.not.include('"$id"');
    expect(after).to.not.include('"$defs"');
    expect(after).to.not.include('#/$defs/');
    expect(after).to.include('"definitions"');
    expect(after).to.match(/"\$ref":"#\/definitions\/[A-Za-z_]+"/);
    expect(Object.keys(safe.definitions).sort()).to.deep.equal(Object.keys(findings.$defs).sort());
    expect(JSON.stringify(findings), 'the contract schema is not mutated').to.equal(before);
    expect(forStructuredOutput(safe), 'idempotent').to.deep.equal(safe);
    expect(safe.type).to.equal('object');
    expect(safe.properties.project_url).to.deep.equal(findings.properties.project_url);
  });

  it('converts the committed schema files the same way and keeps their constraints', () => {
    for (const name of ['findings', 'brief']) {
      const committed = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
      const safe = forStructuredOutput(committed);
      expect(safe.$schema).to.equal(undefined);
      expect(safe.$id).to.equal(undefined);
      expect(JSON.stringify(safe)).to.not.include('$defs');
      expect(safe.required).to.deep.equal(committed.required);
      expect(safe.additionalProperties).to.equal(committed.additionalProperties);
    }
  });

  it('merges a definitions block already present with renamed $defs and leaves other keywords alone', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      definitions: { a: { type: 'string' } },
      $defs: { b: { type: 'number' } },
      properties: { x: { $ref: '#/$defs/b' }, y: { $ref: '#/definitions/a' }, z: { enum: ['p', 'q'] } },
    };
    expect(forStructuredOutput(schema)).to.deep.equal({
      definitions: { a: { type: 'string' }, b: { type: 'number' } },
      properties: { x: { $ref: '#/definitions/b' }, y: { $ref: '#/definitions/a' }, z: { enum: ['p', 'q'] } },
    });
  });
});
