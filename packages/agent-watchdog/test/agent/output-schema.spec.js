const fs = require('node:fs');
const path = require('node:path');
const { findingsSchema, briefSchema, toJsonSchemas } = require('../../src/agent/output-schema');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schema');

describe('agent/output-schema', () => {
  it('generates JSON Schema 2020-12 documents that forbid additional properties', () => {
    const { findings, brief } = toJsonSchemas();
    expect(findings.$schema).to.equal('https://json-schema.org/draft/2020-12/schema');
    expect(findings.additionalProperties).to.equal(false);
    expect(findings.required).to.include.members(
      ['project_url', 'pass', 'items', 'not_selected', 'changes', 'converged', 'notes'],
    );
    expect(brief.required).to.include.members(
      ['headline', 'bullets', 'thread_order', 'expected_load_notice', 'memory_update', 'proposals'],
    );
  });

  it('matches the committed schema files (run npm run schema:build after changing the zod definitions)', () => {
    const { findings, brief } = toJsonSchemas();
    expect(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'findings.schema.json'), 'utf8'))).to.deep.equal(findings);
    expect(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'brief.schema.json'), 'utf8'))).to.deep.equal(brief);
  });

  it('accepts a valid findings document and rejects an unknown field or severity', () => {
    const file = path.join(__dirname, '..', 'fixtures', 'findings', 'pass1.valid.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(findingsSchema.safeParse(doc).success).to.equal(true);
    const bad = { ...doc, items: [{ ...doc.items[0], severity: 'urgent' }] };
    expect(findingsSchema.safeParse(bad).success).to.equal(false);
    expect(findingsSchema.safeParse({ ...doc, extra: 1 }).success).to.equal(false);
  });

  it('never lets the model emit URL fields other than reference_urls', () => {
    const { findings } = toJsonSchemas();
    const text = JSON.stringify(findings);
    expect(text).to.not.match(/"(url|link|href|dashboard_url)"/);
    expect(findings.$defs.item.properties).to.have.property('reference_urls');
  });

  it('accepts a valid brief draft and rejects a fourth bullet at validation time in the gate, not the schema', () => {
    const draft = {
      headline: 'h',
      bullets: [{ item_id: 'a', text: 't' }],
      thread_order: ['a'],
      expected_load_notice: null,
      memory_update: { replace_with: null },
      proposals: [],
    };
    expect(briefSchema.safeParse(draft).success).to.equal(true);
    expect(briefSchema.safeParse({ ...draft, headline: 5 }).success).to.equal(false);
  });
});
