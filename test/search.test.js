const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { normalize, parse } = require('../src/search')
const Library = require('../src/database')

test('normalize', () => {
  assert.strictEqual(normalize('PS_49_City_Pedestrian Street'), 'ps 49 city pedestrian street')
  assert.strictEqual(normalize('Forêt-été.wav'), 'foret ete wav')
})

test('parse', () => {
  assert.deepStrictEqual(parse('name: "city square" tag:wolf -beep'), [
    { field: 'name', value: 'city square', negate: false },
    { field: 'tag', value: 'wolf', negate: false },
    { field: 'any', value: 'beep', negate: true }
  ])
  assert.deepStrictEqual(parse('dur:<2 name:'), [{ field: 'dur', value: '<2', negate: false }])
})

test('search and sort', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-test-')), 'test.db')
  const library = new Library(file)

  library.insertFiles([
    { path: 'GDC Bundle 2019/West Wolf - Pedestrian Streets/PS_49_City_Pedestrian Street.wav', size: 300, mtime: 1 },
    { path: 'PremiumBeat SFX/PremiumBeat_0013_cursor_click_24.wav', size: 100, mtime: 3 },
    { path: 'PremiumBeat SFX/street_noise.wav', size: 200, mtime: 2 }
  ])

  const names = (q, sort, order) => library.list({ q, sort, order }).files.map((f) => f.name)

  assert.deepStrictEqual(names('street'), ['PS_49_City_Pedestrian Street.wav', 'street_noise.wav'])
  assert.deepStrictEqual(names('tag:"west wolf"'), ['PS_49_City_Pedestrian Street.wav'])
  assert.deepStrictEqual(names('name:"pedestrian street"'), ['PS_49_City_Pedestrian Street.wav'])
  assert.deepStrictEqual(names('premiumbeat -click'), ['street_noise.wav'])
  assert.deepStrictEqual(names('tag:premiumbeat street'), ['street_noise.wav'])
  assert.deepStrictEqual(names('', 'size', 'desc'), ['PS_49_City_Pedestrian Street.wav', 'street_noise.wav', 'PremiumBeat_0013_cursor_click_24.wav'])
  assert.deepStrictEqual(names('', 'date', 'asc'), ['PS_49_City_Pedestrian Street.wav', 'street_noise.wav', 'PremiumBeat_0013_cursor_click_24.wav'])

  library.addTag(2, 'Fortune Avenue')
  assert.deepStrictEqual(names('fortune'), ['PremiumBeat_0013_cursor_click_24.wav'])
  library.removeTag(2, 'Fortune Avenue')
  assert.deepStrictEqual(names('fortune'), [])

  library.close()
})
