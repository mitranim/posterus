'use strict'

/**
 * Dependencies
 */

const $ = require('gulp-load-plugins')()
const del = require('del')
const gulp = require('gulp')
const log = require('fancy-log')
const {Transform} = require('stream')
const {fork} = require('child_process')

/**
 * Globals
 */

const _libDir = 'lib'
const distDir = 'dist'
const libFiles = 'lib/**/*.js'
const distFiles = 'dist/**/*.js'
const testFiles = 'test/**/*.js'

const GulpErr = msg => ({showStack: false, toString: () => msg})

/**
 * Tasks
 */

gulp.task('clear', () => (
  del(distFiles).catch(console.error.bind(console))
))

gulp.task('compile', () => (
  gulp.src(libFiles)
    .pipe($.babel())
    // Mangles "private" properties to reduce API surface and potential confusion
    .pipe($.uglify({
      mangle: false,
      compress: false,
      output: {beautify: true},
      mangleProperties: {regex: /_$/},
    }))
    .pipe(gulp.dest(distDir))
    // Ensures ES5 compliance and lets us measure minified size
    .pipe($.uglify({
      mangle: {toplevel: true},
      compress: {warnings: false},
    }))
    .pipe(new Transform({
      objectMode: true,
      transform(file, __, done) {
        log(`Minified size: ${file._contents.length} bytes`)
        done()
      },
    }))
))

let testProc = null

process.once('exit', () => {
  if (testProc) testProc.kill()
})

gulp.task('test', done => {
  // Still running, let it finish
  if (testProc && testProc.exitCode == null) {
    done()
    return
  }

  testProc = fork('./test/test')

  testProc.once('exit', code => {
    done(code ? GulpErr(`Test failed with exit code ${code}`) : null)
  })
})

gulp.task('lint', () => (
  gulp.src(libFiles)
    .pipe($.eslint())
    .pipe($.eslint.format())
    .pipe($.eslint.failAfterError())
))

gulp.task('watch', () => {
  $.watch(libFiles, gulp.series('clear', 'compile', 'test'))
  $.watch(testFiles, gulp.series('test'))
})

gulp.task('build', gulp.series('clear', 'compile', 'test', 'lint'))

gulp.task('default', gulp.series('build', 'watch'))
