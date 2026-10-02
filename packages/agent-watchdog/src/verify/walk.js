'use strict';
// Visit every string in a JSON-like value with its path, for the secret and personal-data checks.
const walkStrings = (value, visit, path = '$') => {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, visit, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      walkStrings(inner, visit, `${path}.${key}`);
    }
  }
};

module.exports = { walkStrings };
