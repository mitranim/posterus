'use strict'

const Queue = require('fastqueue')

/**
 * Interfaces
 */

exports.isFuture = isFuture
function isFuture(value) {
  return isObject(value) &&
    isFunction(value.settle) &&
    isFunction(value.map) &&
    isFunction(value.deinit)
}

/**
 * Scheduler
 */

class Scheduler {
  constructor(deque) {
    validate(deque, isFunction)
    this.pending_ = new Queue()
    this.deque_ = deque
    this.isScheduled_ = false
    this.scheduledTick_ = scheduledTick.bind(undefined, this)
    this.asap = chooseAsapImplementation(this.scheduledTick_)
  }

  // No cancelation for individual elements: it'd be too expensive.
  // The deque function must take this into account.
  push(value) {
    this.pending_.push(value)
    if (this.pending_.length) scheduleTick(this)
  }

  // Can be called synchronously to drain the pending que
  tick() {
    const deque = this.deque_
    // Ensures exception resilience without obfuscating the throw site
    try {
      while (this.pending_.length) deque(this.pending_.shift())
    }
    finally {
      if (this.pending_.length) scheduleTick(this)
    }
  }

  deinit() {
    while (this.pending_.length) this.pending_.shift()
  }
}

exports.Scheduler = Scheduler

function scheduleTick(scheduler) {
  if (!scheduler.isScheduled_) {
    scheduler.isScheduled_ = true
    scheduler.asap.call(undefined, scheduler.scheduledTick_)
  }
}

function scheduledTick(scheduler) {
  scheduler.isScheduled_ = false
  scheduler.tick()
}

/**
 * Future
 */

// Using one numeric field with bitmasks instead of multiple boolean fields
// saves significant amounts of memory.
const PENDING           = 0b00000001 | 0
const ERROR             = 0b00000010 | 0
const SUCCESS           = 0b00000100 | 0
const PENDING_REJECTION = 0b00001000 | 0
const CONSUMED          = 0b00010000 | 0
const MAPPING           = 0b00100000 | 0
const SET_ALL           = 0b11111111 | 0
const UNSET_STATE       = SET_ALL ^ (PENDING | ERROR | SUCCESS)
const SETTLED           = ERROR | SUCCESS

class Future {
  constructor() {
    this.bits_        = PENDING
    this.value_       = undefined
    this.predecessor_ = undefined
    this.successor_   = undefined
    this.weaks_       = undefined
    this.mapper_      = undefined
    this.finalizer_   = undefined
  }

  deref() {
    if (someBitsSet(this, ERROR)) {
      unsetBits(this, PENDING_REJECTION)
      throw this.value_
    }
    return this.value_
  }

  settle(error, result) {
    if (someBitsSet(this, SETTLED | MAPPING)) return

    if (error === this || result === this) {
      throw Error(`A future can't be chained to itself`)
    }

    if (error) result = undefined
    else error = undefined

    if (isFuture(error)) {
      if (isBaseFuture(error)) {
        if (someBitsSet(error, CONSUMED)) throw Error(nonConsumableFutureMessage)
        if (!error.successor_ && !this.mapper_) {
          this.mapper_ = alwaysThrow
          setupPredecessorSuccessorPair(error, this)
          return
        }
      }
      const errorSettle = (error, result) => {this.settle(error || result)}
      this.predecessor_ = error.map(errorSettle)
      return
    }

    if (isFuture(result)) {
      if (isBaseFuture(result)) {
        if (someBitsSet(result, CONSUMED)) throw Error(nonConsumableFutureMessage)
        if (!result.successor_) {
          setupPredecessorSuccessorPair(result, this)
          return
        }
      }
      const valueSettle = (error, result) => {this.settle(error, result)}
      this.predecessor_ = result.map(valueSettle)
      return
    }

    const mapper = this.mapper_
    this.mapper_ = undefined
    if (mapper) {
      setBits(this, MAPPING)
      try {
        result = mapper(error, result)
        error = undefined
      }
      catch (err) {
        error = err
        result = undefined
      }
      finally {
        unsetBits(this, MAPPING)
      }
      this.settle(error, result)
      return
    }

    this.value_ = error || result
    replaceStateBits(this, error ? ERROR : SUCCESS)
    if (error) setBits(this, PENDING_REJECTION)
    scheduleFuture(this)
  }

  map(mapper) {
    validate(mapper, isFunction)
    if (someBitsSet(this, CONSUMED)) throw Error(nonConsumableFutureMessage)
    setBits(this, CONSUMED)
    unsetBits(this, PENDING_REJECTION)
    const future = new this.constructor()
    future.mapper_ = mapper
    setupPredecessorSuccessorPair(this, future)
    return future
  }

  mapError(mapper) {
    validate(mapper, isFunction)
    return this.map(mapError.bind(undefined, mapper))
  }

  mapResult(mapper) {
    validate(mapper, isFunction)
    return this.map(mapResult.bind(undefined, mapper))
  }

  finally(mapper) {
    validate(mapper, isFunction)
    return this.map(mapFinally.bind(undefined, mapper))
  }

  weak() {
    const future = new this.constructor()
    if (!this.weaks_) this.weaks_ = new Queue()
    this.weaks_.push(future)
    scheduleFuture(this)
    return future
  }

  toPromise() {
    if (someBitsSet(this, CONSUMED)) throw Error(nonConsumableFutureMessage)
    unsetBits(this, PENDING_REJECTION)
    if (someBitsSet(this, ERROR)) return Promise.reject(this.value_)
    if (someBitsSet(this, SUCCESS)) return Promise.resolve(this.value_)
    return new Promise(mapFutureToPromise.bind(undefined, this))
  }

  catch() {
    return this.toPromise().catch(...arguments)
  }

  then() {
    return this.toPromise().then(...arguments)
  }

  finishPending() {
    if (someBitsSet(this, SETTLED)) {
      // Not expecting exceptions here
      const successor = this.successor_
      this.successor_ = undefined
      if (successor) {
        unsetBits(this, PENDING_REJECTION)
        if (someBitsSet(this, ERROR)) successor.settle(this.value_)
        else successor.settle(undefined, this.value_)
      }

      // Not expecting exceptions here
      while (this.weaks_ && this.weaks_.length) {
        const weak = this.weaks_.shift()
        if (someBitsSet(this, ERROR)) weak.settle(this.value_)
        else weak.settle(undefined, this.value_)
      }

      finalize(this)
    }

    // Problematic: obfuscates the original throw/settle site
    if (someBitsSet(this, PENDING_REJECTION)) {
      unsetBits(this, PENDING_REJECTION)
      this.constructor.onUnhandledRejection(this)
    }
  }

  deinit() {
    if (someBitsSet(this, MAPPING)) return

    // The mapper, if any, may replace the predecessor during `settle`. We
    // must stash the current predecessor and deinit both.

    const prevPredecessor = this.predecessor_
    this.predecessor_ = undefined

    try {
      if (!someBitsSet(this, SETTLED)) this.settle(Error(deinitErrorMessage))
      unsetBits(this, PENDING_REJECTION)
    }
    finally {
      try {
        finalize(this)
      }
      finally {
        try {
          if (prevPredecessor) prevPredecessor.deinit()
        }
        finally {
          const nextPredecessor = this.predecessor_
          this.predecessor_ = undefined
          if (nextPredecessor) nextPredecessor.deinit()
        }
      }
    }
  }

  // For REPL convenience. Has no memory cost unless poked.
  get state() {
    return {
      PENDING:           someBitsSet(this, PENDING),
      ERROR:             someBitsSet(this, ERROR),
      SUCCESS:           someBitsSet(this, SUCCESS),
      PENDING_REJECTION: someBitsSet(this, PENDING_REJECTION),
      CONSUMED:          someBitsSet(this, CONSUMED),
      MAPPING:           someBitsSet(this, MAPPING),
    }
  }

  static from(error, result) {
    const future = new this()
    future.settle(error, result)
    return future
  }

  static fromError(error) {
    validate(error, Boolean)
    return this.from(error)
  }

  static fromResult(result) {
    return isFuture(result) ? result : this.from(undefined, result)
  }

  static fromPromise(promise) {
    validate(promise, isPromise)
    const future = new this()
    promise.then(future.settle.bind(future, undefined), future.settle.bind(future))
    return future
  }

  static all(values) {
    validate(values, isArray)
    const future = new this()
    new JunctureAll(future, values)  // eslint-disable-line no-new
    return future
  }

  static race(values) {
    validate(values, isArray)
    const future = new this()
    new JunctureRace(future, values)  // eslint-disable-line no-new
    return future
  }

  static onUnhandledRejection(future) {
    throw future.value_  // unhandled rejection
  }
}

Future.scheduler = new Scheduler(function finishPending(future) {
  future.finishPending()
})

exports.Future = Future

/**
 * All
 */

class JunctureAll {
  constructor(future, values) {
    this.future_ = future
    values = this.values_ = values.slice()

    for (let i = -1; ++i < values.length;) {
      const value = values[i]
      if (!isFuture(value)) continue

      if (isBaseFuture(value)) {
        if (someBitsSet(value, CONSUMED)) throw Error(nonConsumableFutureMessage)

        if (someBitsSet(value, ERROR)) {
          this.settle_(value)
          return
        }

        if (someBitsSet(value, SUCCESS)) {
          values[i] = quietlyConsume(value)
          continue
        }

        if (!value.finalizer_) {
          setupFinalizer(value, this.settleAtIndex_.bind(this, i))
          continue
        }
      }

      values[i] = value.map(this.settleAtIndex_.bind(this, i))
    }

    if (values.some(isFuture)) {
      // This includes future.deinit()
      const deinitOnError = error => {if (error) this.deinit()}
      future.finalizer_ = deinitOnError
    }
    else {
      this.settle_()
    }
  }

  settleAtIndex_(i, error, result) {
    const values = this.values_
    if (!values) return
    if (error) this.settle_(error)
    else {
      values[i] = result
      if (!values.some(isFuture)) this.settle_()
    }
  }

  settle_(error) {
    const future = this.future_
    this.future_ = undefined
    const values = this.values_
    this.values_ = undefined
    if (error) {
      future.settle(error)
      forceDeinitFutures(values)
    }
    else {
      future.settle(undefined, values)
    }
  }

  deinit() {
    this.future_ = undefined
    const values = this.values_
    this.values_ = undefined
    forceDeinitFutures(values)
  }
}

/**
 * Race
 */

class JunctureRace {
  constructor(future, values) {
    this.future_ = future
    values = this.values_ = values.slice()
    const settle = this.settle_.bind(this)

    for (let i = -1; ++i < values.length;) {
      const value = values[i]

      if (!isFuture(value)) {
        this.settle_(undefined, value)
        return
      }

      if (isBaseFuture(value)) {
        if (someBitsSet(value, CONSUMED)) throw Error(nonConsumableFutureMessage)

        if (someBitsSet(value, ERROR)) {
          this.settle_(value)
          return
        }

        if (someBitsSet(value, SUCCESS)) {
          this.settle_(undefined, quietlyConsume(value))
          return
        }

        if (!value.finalizer_) {
          setupFinalizer(value, settle)
          continue
        }
      }

      values[i] = value.map(settle)
    }

    if (values.some(isFuture)) {
      // This includes future.deinit()
      const deinitOnError = error => {if (error) this.deinit()}
      future.finalizer_ = deinitOnError
    }
    else {
      this.settle_()
    }
  }

  settle_(error, result) {
    const future = this.future_
    this.future_ = undefined
    const values = this.values_
    this.values_ = undefined
    if (!future) return
    future.settle(error, result)
    forceDeinitFutures(values)
  }

  deinit() {
    this.future_ = undefined
    const values = this.values_
    this.values_ = undefined
    forceDeinitFutures(values)
  }
}

/**
 * Utils
 */

const nonConsumableFutureMessage = `Expected a consumable future: one that has not been mapped or passed to .settle`

const deinitErrorMessage = 'DEINIT'

// Tentative, undocumented
exports.isDeinitError = isDeinitError
function isDeinitError(value) {
  return isObject(value) && value instanceof Error && value.message === deinitErrorMessage
}

function alwaysThrow(error, result) {
  throw error || result
}

function mapError(fun, error, result) {
  return error ? fun(error) : result
}

function mapResult(fun, error, result) {
  if (error) throw error
  return fun(result)
}

function mapFinally(fun, error, result) {
  const finalization = fun(error, result)
  if (isFuture(finalization)) {
    return finalization.mapResult(function resetResult() {return result})
  }
  if (error) throw error
  return result
}

function mapFutureToPromise(future, resolve, reject) {
  function settleFuturePromise(error, result) {
    unsetBits(future, PENDING_REJECTION)
    if (error) reject(error)
    else resolve(result)
  }
  if (!future.finalizer_) setupFinalizer(future, settleFuturePromise)
  else future.map(settleFuturePromise)
}

function scheduleFuture(future) {
  (future.constructor.scheduler || Future.scheduler).push(future)
}

function setupPredecessorSuccessorPair(predecessor, successor) {
  predecessor.successor_ = successor
  successor.predecessor_ = predecessor
  if (someBitsSet(predecessor, SETTLED)) scheduleFuture(predecessor)
}

function setupFinalizer(future, fun) {
  future.finalizer_ = fun
  if (someBitsSet(future, SETTLED)) scheduleFuture(future)
}

function quietlyConsume(future) {
  setBits(future, CONSUMED)
  return future.value_
}

function finalize(future) {
  const finalizer = future.finalizer_
  future.finalizer_ = undefined
  if (isFunction(finalizer)) {
    if (someBitsSet(future, ERROR)) finalizer(future.value_)
    else finalizer(undefined, future.value_)
  }
}

function isFunction(value) {
  return typeof value === 'function'
}

function isArray(value) {
  return isObject(value) && value instanceof Array
}

function isObject(value) {
  return value != null && typeof value === 'object'
}

function isPromise(value) {
  return isObject(value) && isFunction(value.then)
}

// Used for shortcut optimizations. They require instances of the base Future
// class because subclasses may break our assumptions about the internals.
function isBaseFuture(value) {
  return isObject(value) && value.constructor === Future
}

function validate(value, test) {
  if (!test(value)) throw Error(`Expected ${value} to satisfy test ${test.name}`)
}

function forceDeinitFutures(list) {
  if (isArray(list)) forceEach(list, deinitFuture)
}

function deinitFuture(value) {
  if (isFuture(value)) value.deinit()
}

function forceEach(list, fun) {
  let error = undefined
  for (let i = -1; ++i < list.length;) {
    const value = list[i]
    try {fun(value)}
    catch (err) {error = err}
  }
  if (error) throw error
}

function someBitsSet(future, bitmask) {
  return (future.bits_ & bitmask) !== 0
}

function setBits(future, bitmask) {
  future.bits_ |= bitmask
}

function unsetBits(future, bitmask) {
  future.bits_ &= ~bitmask
}

function replaceStateBits(future, bitmask) {
  future.bits_ = (future.bits_ & UNSET_STATE) | bitmask
}

/* eslint-disable no-restricted-globals */
function chooseAsapImplementation(fun) {
  if (typeof self === 'undefined' && typeof process === 'object' && process && process.nextTick) {
    return process.nextTick
  }
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel()
    channel.port1.onmessage = fun
    // The `undefined` argument is required.
    return function asap() {channel.port2.postMessage(undefined)}
  }
  return setTimeout
}
/* eslint-enable no-restricted-globals */
