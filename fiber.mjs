// Optional generator-based coroutines for Posterus.

/* eslint-disable no-invalid-this */

import * as p from './posterus.mjs'

export class Fiber extends p.Task {
  constructor(iter) {
    valid(iter, isIter)
    super()
    this.t = iter
  }

  done(err, val) {
    try {
      const next = err ? this.t.throw(err) : this.t.next(val)

      err = undefined
      val = maybeFromIter(next.value)

      if (next.done) this.done = super.done
    }
    catch (err) {
      this.d = false
      this.done = super.done
      return this.done(err)
    }

    if (p.isTask(val)) return super.done(err, val)
    return this.done(err, val)
  }
}

export function fiber(fun) {
  valid(fun, isGen)
  return fromGen.bind(fun)
}

export function fiberAsync(fun) {
  valid(fun, isGen)
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
    isObj(val) &&
    isFun(val.next) &&
    isFun(val.return) &&
    isFun(val.throw)
  )
}

function maybeFromIter(val) {return isIter(val) ? fromIter(val) : val}

const GeneratorFunction = (function* () {}).constructor // eslint-disable-line func-names

function isGen(val) {return isFun(val) && val.constructor === GeneratorFunction}
function isFun(val) {return typeof val === 'function'}
function isObj(val) {return val != null && typeof val === 'object'}

function valid(val, test) {
  if (!test(val)) throw Error(`expected ${val} to satisfy test ${test.name}`)
}
