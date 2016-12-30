const nexe = require('nexe');
module.exports = function(grunt) {
  grunt.registerTask('default', 'Build executable.', function() {
    const done = this.async();
    nexe.compile({
      input: 'index.js', // where the input file is
      output: 'dist/fswatcher', // where to output the compiled binary
      nodeVersion: '7.3.0', // node version
      nodeTempDir: 'src', // where to store node source.
      // nodeConfigureArgs: ['opt', 'val'], // for all your configure arg needs.
      // nodeMakeArgs: ["-j", "4"], // when you want to control the make process.
      // python: 'path/to/python', // for non-standard python setups. Or python 3.x forced ones.
      // resourceFiles: [ 'path/to/a/file' ], // array of files to embed.
      // resourceRoot: [ 'path/' ], // where to embed the resourceFiles.
      flags: true, // use this for applications that need command line flags.
      // jsFlags: "--use_strict", // v8 flags
      framework: 'node' // node, nodejs, or iojs
    }, function(err) {
      if(err) {
        grunt.log.writeln('Failed!: ' + err);
      } else {
        grunt.log.writeln('Excutable created!');
      }
      done(!err);
    });
  });
};