var parse   = require('./lib/index')
var Preprocessor = require('./lib/preprocessor')
var through = require('through2').obj

module.exports = parseStream

function parseStream() {
  var preprocessor = new Preprocessor()
  var parser = parse()
  var stream = through(write, flush)

  stream.program = parser.program
  stream.scope   = parser.scope
  stream.diagnostics = parser.program.diagnostics

  return stream

  function write(data, _, next) {
    var tokens = preprocessor.process([data])

    for (var i = 0; i < tokens.length; i++) {
      var nodes = parser(tokens[i])

      for (var j = 0; j < nodes.length; j++) {
        this.push(nodes[j])
      }
    }

    next()
  }

  function flush() {
    var tokens = preprocessor.end()
    for (var i = 0; i < tokens.length; i++) {
      var nodes = parser(tokens[i])
      for (var j = 0; j < nodes.length; j++) {
        this.push(nodes[j])
      }
    }
    if(preprocessor.diagnostics.length) {
      this.program.diagnostics = preprocessor.diagnostics.concat(this.program.diagnostics || [])
    }
    this.push(null)
  }
}
