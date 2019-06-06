'use strict'

/**
 * Dependencies
 */

const $ = require('gulp-load-plugins')()
const del = require('del')
const gulp = require('gulp')
// Peer dependency
const File = require('vinyl')
const log = require('fancy-log')
const uglifyEs = require('uglify-es')
const uglifyJs = require('uglify-js')
const {Transform} = require('stream')
const {fork} = require('child_process')

/**
 * Globals
 */

const srcFiles = 'src/**/*.js'
const typeFiles = 'src/**/*.d.ts'
const esDir = 'es'
const distDir = 'dist'
const testFiles = 'test/**/*.js'

const GulpErr = msg => ({showStack: false, toString: () => msg})

// Simpler and better than gulp-uglify
function uglifyStream(uglify, options) {
  return new Transform({
    objectMode: true,
    transform(file, __, done) {
      if (!file.isBuffer()) {
        done()
        return
      }

      const {relative, contents} = file
      const output = uglify.minify(String(contents), options)

      if (!output) {
        done(GulpErr(`Unable to minify ${relative}`))
        return
      }

      const {error, warnings, code} = output
      if (error) {
        done(GulpErr(error))
        return
      }
      if (warnings) for (const warning of warnings) log.warn(warning)

      done(undefined, new File({
        path: relative,
        contents: Buffer.from(code),
      }))
    },
  })
}

/**
 * Tasks
 */

gulp.task('clear', () => (
  del([
    `${esDir}/*`,
    `${distDir}/*`,
  ]).catch(console.error.bind(console))
))

gulp.task('compile', () => (
  gulp.src(srcFiles)
    .pipe($.babel())
    // Mangles "private" properties to reduce API surface and potential confusion
    .pipe(uglifyStream(uglifyEs, {
      mangle: {keep_fnames: true, properties: {regex: /_$/}},
      compress: false,
      output: {beautify: true},
    }))
    .pipe(gulp.dest(esDir))
    .pipe($.babel({
      plugins: [
        ['transform-es2015-modules-commonjs', {strict: true}],
      ],
    }))
    .pipe(gulp.dest(distDir))
    // Ensure ES5 compliance; let us measure minified size
    .pipe(uglifyStream(uglifyJs, {
      mangle: {toplevel: true},
      compress: {warnings: false},
    }))
    .pipe(new Transform({
      objectMode: true,
      transform(file, __, done) {
        log(`Minified size: ${file.relative} — ${file._contents.length} bytes`)
        done()
      },
    }))
))

gulp.task('types', () => (
  gulp.src(typeFiles)
    .pipe(gulp.dest(esDir))
    .pipe(gulp.dest(distDir))
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
  gulp.src(srcFiles)
    .pipe($.eslint())
    .pipe($.eslint.format())
    .pipe($.eslint.failAfterError())
))

gulp.task('watch', () => {
  $.watch(srcFiles, gulp.series('clear', 'compile', 'test'))
  $.watch(testFiles, gulp.series('test'))
})

gulp.task('build', gulp.series('clear', 'compile', 'types', 'test', 'lint'))

gulp.task('default', gulp.series('build', 'watch'))
