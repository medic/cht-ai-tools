// The example environment file is the source of truth for names and defaults (contracts/environment.md). Docker
// Compose's env_file keeps text after `#` on a value line as part of the value while Node's --env-file drops it, so
// the file keeps comments on their own lines and both readers see the same values (revision 31).
const fs = require('node:fs');
const path = require('node:path');
const { VARIABLES } = require('../../src/config/schema');

const text = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
const lines = text.split('\n');

describe('config: .env.example', () => {
  it('has comments on their own lines only, so Compose and Node read the same values', () => {
    const valueLines = lines.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l));
    const withInlineComment = valueLines.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=[^"']*\s#/.test(l));
    expect(withInlineComment).to.deep.equal([]);
    const shapes = lines.filter((l) => l.trim() && !l.startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l));
    expect(shapes, 'every non-comment line is KEY=value').to.deep.equal([]);
  });

  it('names every variable the schema reads and nothing the schema does not', () => {
    const named = new Set(lines.map((l) => (/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l) || [])[1]).filter(Boolean));
    const known = new Set(VARIABLES.map((v) => v.env));
    expect([...known].filter((env) => !named.has(env))).to.deep.equal([]);
    expect([...named].filter((env) => !known.has(env))).to.deep.equal([]);
  });
});
