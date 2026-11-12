// Search syntax:
//   footsteps gravel        every word must match the file name OR a tag
//   "city square"           quoted phrase, same rule
//   name: "city square"     file name only
//   tag: "west wolf"        tags only (folder names and your own tags)
//   ext: wav                extension
//   dur: <2  dur: >10  dur: 1-3   duration in seconds
//   -word  -tag: foo        exclude

const TOKEN = /(-?)(?:(name|tag|ext|dur)\s*:\s*)?(?:"([^"]*)"?|(\S+))/gi

function normalize (text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function parse (query) {
  const terms = []

  for (const match of String(query || '').matchAll(TOKEN)) {
    const [, negate, field, quoted, word] = match
    const raw = quoted !== undefined ? quoted : word

    // "name:" alone, the user is still typing
    if (!field && /^(name|tag|ext|dur):$/i.test(raw)) continue

    terms.push({ field: (field || 'any').toLowerCase(), value: raw, negate: negate === '-' })
  }

  return terms
}

function parseDuration (value) {
  const compare = /^([<>]=?)\s*(\d+(?:\.\d+)?)$/.exec(value)

  if (compare) return { sql: `duration ${compare[1]} ?`, params: [parseFloat(compare[2])] }

  const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(value)

  if (range) return { sql: 'duration BETWEEN ? AND ?', params: [parseFloat(range[1]), parseFloat(range[2])] }

  return null
}

function toCondition ({ field, value }) {
  if (field === 'dur') return parseDuration(value.trim())

  if (field === 'ext') {
    const ext = value.trim().toLowerCase().replace(/^\./, '')

    return ext ? { sql: 'ext = ?', params: [ext] } : null
  }

  const text = normalize(value)

  if (!text) return null
  if (field === 'name') return { sql: 'instr(search_name, ?) > 0', params: [text] }
  if (field === 'tag') return { sql: 'instr(search_tags, ?) > 0', params: [text] }

  return { sql: '(instr(search_name, ?) > 0 OR instr(search_tags, ?) > 0)', params: [text, text] }
}

function buildWhere (query) {
  const clauses = []
  const params = []

  for (const term of parse(query)) {
    const condition = toCondition(term)

    if (!condition) continue

    clauses.push(term.negate ? `NOT (${condition.sql})` : condition.sql)
    params.push(...condition.params)
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  }
}

module.exports = { normalize, parse, buildWhere }
