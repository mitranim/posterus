'use strict'

/* eslint-disable global-require */

/**
 * Dependencies
 */

const $ = require('gulp-load-plugins')()
const del = require('del')
const gulp = require('gulp')
const {exec} = require('child_process')
const chalk = require('chalk')

/**
 * Globals
 */

const src = {
  lib: 'lib/**/*.js',
  dist: 'dist/**/*.js',
  test: 'test/**/*.js',
}

const out = {
  lib: 'dist',
}

let testProc = null

function rerequire (name) {
  delete require.cache[require.resolve(name)]
  return require(name)
}

/**
 * Tasks
 */

gulp.task('clear', () => (
  del(out.lib).catch(console.error.bind(console))
))

gulp.task('compile', () => (
  gulp.src(src.lib)
    .pipe($.babel())
    // Mangles "private" properties to reduce API surface and potential confusion
    .pipe($.uglify({
      mangle: false,
      compress: false,
      output: {beautify: true},
      mangleProperties: {regex: /_$/},
    }))
    .pipe(gulp.dest(out.lib))
))

// Ensures ES5 compliance and shows minified size
gulp.task('minify', () => (
  gulp.src(src.dist, {ignore: '**/*.min.js'})
    .pipe($.uglify({
      mangle: {toplevel: true},
      compress: {warnings: false},
    }))
    .pipe($.rename(path => {
      path.extname = '.min.js'
    }))
    .pipe(gulp.dest(out.lib))
))

gulp.task('test', done => {
  if (testProc) {
    // Still running, let it finish
    if (testProc.exitCode == null) {
      done()
      return
    }
    testProc.kill()
  }

  testProc = exec(
    rerequire('./package').scripts.test,
    (err, stdout, stderr) => {
      testProc = null
      process.stdout.write(stdout)
      if (err) {
        done({
          showStack: false,
          toString () {
            return `${chalk.red('Error')} in plugin '${chalk.cyan('lib:test')}':\n${stderr}`
          },
        })
      }
      else {
        process.stderr.write(stderr)
        done(null)
      }
    }
  )
})

gulp.task('lint', () => (
  gulp.src(src.lib)
    .pipe($.eslint())
    .pipe($.eslint.format())
    .pipe($.eslint.failAfterError())
))

gulp.task('watch', () => {
  $.watch(src.lib, gulp.series('clear', 'compile', 'minify', 'test'))
  $.watch(src.test, gulp.series('test'))
})

gulp.task('build', gulp.series('clear', 'compile', 'minify', 'test', 'lint'))

gulp.task('default', gulp.series('build', 'watch'))
