'use strict'

const Queue = require('fastqueue')

/**
 * Interfaces
 */

exports.isFuture = isFuture
function isFuture (value) {
  return (
    isObject(value) &&
    isFunction(value.settle) &&
    isFunction(value.map) &&
    isFunction(value.mapResult) &&
    isFunction(value.mapError) &&
    isFunction(value.deinit)
  )
}

/**
 * Scheduler
 */

class Scheduler {
  constructor () {
    this.pending_ = new Queue()
    this.isScheduled_ = false
    this.onScheduledTick_ = onScheduledTick.bind(null, this)
    this.asap = chooseAsapImplementation(this.onScheduledTick_)
  }

  push (future) {
    this.pending_.push(future)
    if (this.pending_.length) scheduleTick(this)
  }

  // Can be called synchronously to drain the pending que
  tick () {
    // Ensures exception resilience without obfuscating the throw site
    try {
      while (this.pending_.length) this.pending_.shift().finishPending()
    }
    finally {
      if (this.pending_.length) scheduleTick(this)
    }
  }

  deinit () {
    this.pending_ = new Queue()
  }
}

exports.Scheduler = Scheduler

function scheduleTick (scheduler) {
  if (!scheduler.isScheduled_) {
    scheduler.isScheduled_ = true
    scheduler.asap.call(null, scheduler.onScheduledTick_)
  }
}

function onScheduledTick (scheduler) {
  scheduler.isScheduled_ = false
  scheduler.tick()
}

/**
 * Future
 */

// Using bitwise instead of multiple boolean fields saves significant amounts of
// memory (≈25% in V8 at the time of writing)
const _UNSET_ALL        = 0b00000000 | 0
const PENDING           = 0b00000001 | 0
const ERROR             = 0b00000010 | 0
const SUCCESS           = 0b00000100 | 0
const AVERTED           = 0b00001000 | 0
const PENDING_REJECTION = 0b00010000 | 0
const CONSUMED          = 0b00100000 | 0
const MAPPING           = 0b01000000 | 0
const SET_ALL           = 0b11111111 | 0
const UNSET_STATE       = SET_ALL ^ (PENDING | ERROR | SUCCESS | AVERTED)
const SEALED            = AVERTED | CONSUMED

class Future {
  constructor () {
    this.bitfield_ = PENDING
    this.value_ = undefined
    this.prevInChain_ = undefined
    this.nextInChain_ = undefined
    this.weaks_ = undefined
    this.mapper_ = undefined
    this.pendingIniter_ = undefined
    this.deiniter_ = undefined
  }

  deref () {
    if (isSomeSet(this, ERROR)) {
      unset(this, PENDING_REJECTION)
      throw this.value_
    }
    return this.value_
  }

  settle (error, result) {
    if (isNoneSet(this, PENDING) || isSomeSet(this, MAPPING)) return

    if (error === this || result === this) {
      throw Error(`A future can't be chained to itself`)
    }

    this.deiniter_ = undefined

    if (error && isFuture(result)) {
      this.settle(error)
      return
    }

    if (isFuture(error)) {
      if (error instanceof Future) {
        if (isSomeSet(error, SEALED)) {
          this.settle(nonConsumableFutureError())
          return
        }
        linkPair(error, this)
        // We can count on the mapper slot being available here. Reusing it
        // saves memory and simplifies the code.
        this.mapper_ = rethrow
        return
      }
      this.prevInChain_ = error.map(settleAtMappedError.bind(null, this))
      return
    }

    if (isFuture(result)) {
      if (result instanceof Future) {
        if (isSomeSet(result, SEALED)) {
          this.settle(nonConsumableFutureError())
          return
        }
        linkPair(result, this)
        return
      }

      this.prevInChain_ = result.map(settleAtMappedResult.bind(null, this))
      return
    }

    const mapper = this.mapper_
    this.mapper_ = undefined
    if (isFunction(mapper)) {
      set(this, MAPPING)
      let mappedResult = undefined
      try {
        mappedResult = mapper(error, result)
        unset(this, MAPPING)
      }
      catch (err) {
        unset(this, MAPPING)
        settleWithCaughtError(this, err)
        return
      }
      // We don't anticipate exceptions here, so if something unexpected
      // happens, let it blow up early.
      this.settle(undefined, mappedResult)
      return
    }

    replaceState(this, error ? ERROR : SUCCESS)
    this.value_ = error || result

    if (this.nextInChain_ || this.weaks_) {
      scheduleFuture(this)
      return
    }

    if (error) {
      set(this, PENDING_REJECTION)
      scheduleFuture(this)
    }
  }

  map (fun) {
    validate(isFunction, fun)
    if (isSomeSet(this, SEALED)) throw nonConsumableFutureError()
    const nextInChain = new this.constructor()
    linkPair(this, nextInChain)
    nextInChain.mapper_ = fun
    return nextInChain
  }

  mapError (fun) {
    validate(isFunction, fun)
    return this.map(mapToError.bind(null, fun))
  }

  mapResult (fun) {
    validate(isFunction, fun)
    return this.map(mapToResult.bind(null, fun))
  }

  toPromise () {
    unset(this, PENDING_REJECTION)
    return (
      isSomeSet(this, ERROR)
      ? Promise.reject(this.value_)
      : isSomeSet(this, SUCCESS)
      ? Promise.resolve(this.value_)
      : new Promise(mapFutureToPromise.bind(null, this))
    )
  }

  catch () {
    return this.toPromise().catch(...arguments)
  }

  then () {
    return this.toPromise().then(...arguments)
  }

  weak () {
    if (isSomeSet(this, AVERTED)) {
      throw Error(`Can't create a .weak() branch from an averted future`)
    }
    const Future = this.constructor
    if (isSomeSet(this, ERROR)) return Future.fromError(this.value_)
    if (isSomeSet(this, SUCCESS)) return Future.fromResult(this.value_)
    if (!this.weaks_) this.weaks_ = new Queue()
    const future = new Future()
    this.weaks_.push(future)
    return future
  }

  finishPending () {
    if (this.pendingIniter_) {
      const initer = this.pendingIniter_
      this.pendingIniter_ = undefined
      try {this.deiniter_ = initer(this)}
      catch (err) {settleWithCaughtError(this, err)}
    }

    const nextInChain = this.nextInChain_
    if (nextInChain) {
      if (isSomeSet(this, ERROR)) {
        unlinkPair(this, nextInChain)
        nextInChain.settle(this.value_)
      }
      else if (isSomeSet(this, SUCCESS)) {
        unlinkPair(this, nextInChain)
        nextInChain.settle(undefined, this.value_)
      }
    }

    // Not foreseeing any exceptions here; loop should be good enough
    const weaks = this.weaks_
    if (weaks) {
      if (isSomeSet(this, ERROR)) {
        while (weaks.length) weaks.shift().settle(this.value_)
      }
      else if (isSomeSet(this, SUCCESS)) {
        while (weaks.length) weaks.shift().settle(undefined, this.value_)
      }
    }

    if (isSomeSet(this, PENDING_REJECTION)) {
      unset(this, PENDING_REJECTION)
      if (isSomeSet(this, ERROR)) {
        this.constructor.handleRejection(this)
      }
    }
  }

  deinit () {
    if (isSomeSet(this, AVERTED) || isSomeSet(this, MAPPING)) return
    this.bitfield_ = AVERTED

    this.pendingIniter_ = undefined
    this.mapper_ = undefined

    try {
      const deiniter = this.deiniter_
      this.deiniter_ = undefined
      if (isFunction(deiniter)) deiniter()
    }
    finally {
      try {
        const prevInChain = this.prevInChain_
        this.prevInChain_ = undefined
        if (prevInChain) prevInChain.deinit()
      }
      finally {
        try {
          const nextInChain = this.nextInChain_
          this.nextInChain_ = undefined
          if (nextInChain) nextInChain.deinit()
        }
        finally {
          const weaks = this.weaks_
          this.weaks_ = undefined
          if (weaks) forceDeinitFutureQue(weaks, deinit)
        }
      }
    }
  }

  // For REPL convenience. Has no cost unless poked.
  get state () {
    return {
      PENDING:           isSomeSet(this, PENDING),
      ERROR:             isSomeSet(this, ERROR),
      SUCCESS:           isSomeSet(this, SUCCESS),
      AVERTED:           isSomeSet(this, AVERTED),
      PENDING_REJECTION: isSomeSet(this, PENDING_REJECTION),
      CONSUMED:          isSomeSet(this, CONSUMED),
      MAPPING:           isSomeSet(this, MAPPING),
    }
  }

  static init (initer) {
    validate(isFunction, initer)
    const future = new this()
    try {future.deiniter_ = initer(future)}
    catch (err) {settleWithCaughtError(future, err)}
    return future
  }

  static initAsync (initer) {
    validate(isFunction, initer)
    const future = new this()
    future.pendingIniter_ = initer
    scheduleFuture(future)
    return future
  }

  static from (error, result) {
    const future = new this()
    future.settle(error, result)
    return future
  }

  static fromError (error) {
    validate(Boolean, error)
    return this.from(error)
  }

  static fromResult (result) {
    return isFuture(result) ? result : this.from(undefined, result)
  }

  static fromPromise (promise) {
    validate(isPromise, promise)
    const future = new this()
    promise.then(future.settle.bind(future, undefined), future.settle.bind(future))
    return future
  }

  static all (values) {
    validate(isArray, values)
    if (!values.length) return this.fromResult([])
    return new AllJunction(new this(), values.slice()).future_
  }

  static race (values) {
    validate(isArray, values)
    return new RaceJunction(new this(), values.slice()).future_
  }

  // User-overridable
  static handleRejection (future) {
    throw future.value_
  }
}

Future.scheduler = new Scheduler()

exports.Future = Future

/**
 * All
 */

class AllJunction {
  constructor (future, values) {
    this.future_ = future
    this.values_ = values
    future.deiniter_ = this.deinit_.bind(this)

    for (let i = -1; ++i < values.length;) {
      const value = values[i]

      if (!isFuture(value)) continue

      if (value instanceof Future) {
        if (isSomeSet(value, ERROR)) {
          this.settleAtIndex_(i, quetlyConsume(value))
          return
        }

        if (isSomeSet(value, SUCCESS)) {
          values[i] = quetlyConsume(value)
          continue
        }

        if (!value.mapper_) {
          mapInPlace(value, this.settleAtIndex_.bind(this, i))
          continue
        }
      }

      values[i] = value.map(this.settleAtIndex_.bind(this, i))
    }

    this.maybeSettle_()
  }

  settleAtIndex_ (index, error, result) {
    const values = this.values_
    if (!values) return
    if (error) {
      values[index] = undefined
      this.future_.settle(error)
      this.deinit_()
      return
    }
    values[index] = result
    this.maybeSettle_()
  }

  maybeSettle_ () {
    const values = this.values_
    if (!values.some(isFuture)) {
      this.values_ = undefined
      this.future_.settle(undefined, values)
    }
  }

  deinit_ () {
    const values = this.values_
    this.values_ = undefined
    if (values) forceDeinitMaybeFutures(values)
  }
}

/**
 * Race
 */

class RaceJunction {
  constructor (future, values) {
    this.future_ = future
    this.values_ = values
    future.deiniter_ = this.deinit_.bind(this)

    for (let i = -1; ++i < values.length;) {
      const value = values[i]

      if (!isFuture(value)) {
        this.settleAtIndex_(i, undefined, value)
        return
      }

      if (value instanceof Future) {
        if (isSomeSet(value, ERROR)) {
          this.settleAtIndex_(i, quetlyConsume(value))
          return
        }

        if (isSomeSet(value, SUCCESS)) {
          this.settleAtIndex_(i, undefined, quetlyConsume(value))
          return
        }

        if (!value.mapper_) {
          mapInPlace(value, this.settleAtIndex_.bind(this, i))
          continue
        }
      }

      values[i] = value.map(this.settleAtIndex_.bind(this, i))
    }
  }

  settleAtIndex_ (index, error, result) {
    if (this.values_) {
      this.values_[index] = undefined
      this.future_.settle(error, result)
      this.deinit_()
    }
  }

  deinit_ () {
    const values = this.values_
    this.values_ = undefined
    if (values) forceDeinitMaybeFutures(values)
  }
}

/**
 * Utils
 */

function mapToError (fun, error, result) {
  return error ? fun(error) : result
}

function mapToResult (fun, error, result) {
  if (error) throw error
  return fun(result)
}

function settleAtMappedError (future, error, result) {
  future.prevInChain_ = undefined
  future.settle(error || result)
}

function settleAtMappedResult (future, error, result) {
  future.prevInChain_ = undefined
  future.settle(error, result)
}

function settleWithCaughtError (future, err) {
  if (isSomeSet(future, PENDING)) future.settle(err)
  else throw err
}

function unlinkPair (prev, next) {
  prev.nextInChain_ = undefined
  next.prevInChain_ = undefined
}

function linkPair (prev, next) {
  prev.nextInChain_ = next
  next.prevInChain_ = prev
  unset(prev, PENDING_REJECTION)
  set(prev, CONSUMED)
  if (isNoneSet(prev, PENDING)) scheduleFuture(prev)
}

function quetlyConsume (future) {
  unset(future, PENDING_REJECTION)
  set(future, CONSUMED)
  return future.value_
}

function mapInPlace (future, fun) {
  unset(future, PENDING_REJECTION)
  set(future, CONSUMED)
  future.mapper_ = fun
}

function mapFutureToPromise (future, resolve, reject) {
  future.map(function finalizeFuturePromise (error, result) {
    if (error) reject(error)
    else resolve(result)
  })
}

function scheduleFuture (future) {
  (future.constructor.scheduler || Future.scheduler).push(future)
}

function isDeinitable (value) {
  return isObject(value) && isFunction(value.deinit)
}

function isFunction (value) {
  return typeof value === 'function'
}

function isArray (value) {
  return isObject(value) && value instanceof Array
}

function isObject (value) {
  return value != null && typeof value === 'object'
}

function isPromise (value) {
  return isObject(value) && isFunction(value.then)
}

function validate (test, value) {
  if (!test(value)) throw Error(`Expected ${value} to satisfy test ${test.name}`)
}

function rethrow (error, value) {
  throw error || value
}

function nonConsumableFutureError () {
  return Error(`Expected a consumable future (one that has not been averted or mapped)`)
}

function deinit (value) {
  if (isDeinitable(value)) value.deinit()
}

function forceDeinitFutureQue (list) {
  try {
    while (list.length) list.shift().deinit()
  }
  catch (err) {
    forceDeinitFutureQue(list)
    throw err
  }
}

function forceDeinitMaybeFutures (list) {
  let error = null
  for (let i = -1; ++i < list.length;) {
    const value = list[i]
    if (isFuture(value)) {
      try {value.deinit()}
      catch (err) {error = err}
    }
  }
  if (error) throw error
}

function isSomeSet (future, bitmask) {
  return (future.bitfield_ & bitmask) !== 0
}

function isNoneSet (future, bitmask) {
  return (future.bitfield_ & bitmask) === 0
}

function set (future, bitmask) {
  future.bitfield_ |= bitmask
}

function unset (future, bitmask) {
  future.bitfield_ &= ~bitmask
}

function replaceState (future, bitmask) {
  future.bitfield_ = (future.bitfield_ & UNSET_STATE) | bitmask
}

/* eslint-disable no-restricted-globals */
function chooseAsapImplementation (fun) {
  if (typeof self === 'undefined' && typeof process === 'object' && process && process.nextTick) {
    return process.nextTick
  }
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel()
    channel.port1.onmessage = fun
    return function asap () {channel.port2.postMessage(null)}
  }
  return setTimeout
}
/* eslint-enable no-restricted-globals */
