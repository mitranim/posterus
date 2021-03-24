/*
Generator-based coroutines for Posterus. Usage:

  import * as p from 'posterus'
  import * as pf from 'posterus/fiber.mjs'

  // Wrap a generator function; the resulting function returns tasks.
  const someFunc = pf.fiberAsync(function*() {
    yield someTask
    yield someTask
    return someValue
  })

  // Calling returns a running `Task`.
  const task = someFunc()
*/

/* eslint-disable no-invalid-this */

import * as p from './posterus.mjs'

export class Fiber extends p.Task {
  constructor(iter) {
    validate(iter, isIter)
    super()
    this.t = iter
  }

  done(err, val) {
    try {
      const {value, done} = err ? this.t.throw(err) : this.t.next(val)

      err = undefined
      val = maybeFromIter(value)
      if (done) this.done = super.done

      if (p.isTask(val)) return super.done(err, val)
      return this.done(err, val)
    }
    catch (err) {
      return super.done(err)
    }
  }
}

export function fiber(fun) {
  validate(fun, isGen)
  return fromGen.bind(fun)
}

export function fiberAsync(fun) {
  validate(fun, isGen)
  return fromGenAsync.bind(fun)
}

export function fromIter(iter) {
  return new Fiber(iter).done()
}

export function fromIterAsync(iter) {
  const fib = new Fiber(iter)
  p.async.push(fib)
  return fib
}

function fromGen() {
  return fromIter(this(...arguments))
}

function fromGenAsync() {
  return fromIterAsync(this(...arguments))
}

function isIter(val) {
  return (
    isObject(val) &&
    isFunction(val.next) &&
    isFunction(val.return) &&
    isFunction(val.throw)
  )
}

function maybeFromIter(val) {return isIter(val) ? fromIter(val) : val}

function isGen(val) {
  return isFunction(val) && val.constructor === GeneratorFunction
}

const GeneratorFunction = (function* () {}).constructor // eslint-disable-line func-names

function isFunction(val) {
  return typeof val === 'function'
}

function isObject(val) {
  return val != null && typeof val === 'object'
}

function validate(val, test) {
  if (!test(val)) throw Error(`expected ${val} to satisfy test ${test.name}`)
}
