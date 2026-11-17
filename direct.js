var parse = require('./lib/index')
var Preprocessor = require('./lib/preprocessor')

module.exports = parseArray

function parseArray(tokens) {
  var preprocessor = new Preprocessor()
  var parser = parse()

  var expanded = preprocessor.process(tokens)
  expanded = expanded.concat(preprocessor.end())

  for (var i = 0; i < expanded.length; i++) {
    parser(expanded[i])
  }

  var program = parser(null)
  if(preprocessor.diagnostics.length) {
    program.diagnostics = preprocessor.diagnostics.concat(program.diagnostics || [])
  }
  return program
}
