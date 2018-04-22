// Note: the code is written with ES5-style classes to avoid Babel garbage
// in the transpiled code. In large methods, `this` is aliased to `self` for
// better minification. Private properties are mangled for the same reason.

/**
 * Interfaces
 */

export function isFuture(value) {
  return isObject(value) &&
    isFunction(value.settle) &&
    isFunction(value.map) &&
    isFunction(value.deinit)
}

/**
 * Queue
 */

// Version of https://github.com/creationix/fastqueue, modified for size.
// Differences:
//   * mangle all properties other than `.length`
//   * no `unshift` support
function Queue() {
  const self = this
  validateInstance(self, Queue)
  self.length = 0
  self.head_ = []
  self.tail_ = []
  self.index_ = 0
  self.headLength_ = 0
}

Queue.prototype = {
  constructor: Queue,

  push(value) {
    this.length++
    this.tail_.push(value)
  },

  shift() {
    const self = this

    if (self.index_ >= self.headLength_) {
      const tail = self.head_
      tail.length = 0
      self.head_ = self.tail_
      self.tail_ = tail
      self.index_ = 0
      self.headLength_ = self.head_.length
      if (!self.headLength_) return undefined
    }

    const value = self.head_[self.index_]
    self.head_[self.index_++] = undefined
    self.length--
    return value
  },
}

/**
 * Scheduler
 */

export function Scheduler(deque) {
  const self = this
  validateInstance(self, Scheduler)
  validate(deque, isFunction)
  self.pending_ = new Queue()
  self.deque_ = deque
  self.isScheduled_ = false
  self.scheduledTick_ = scheduledTick.bind(null, self)
  self.asap = chooseAsapImplementation(self.scheduledTick_)
}

Scheduler.prototype = {
  constructor: Scheduler,

  // No cancelation for individual elements: it'd be too expensive.
  // The deque function must take this into account.
  push(value) {
    this.pending_.push(value)
    if (this.pending_.length) scheduleTick(this)
  },

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
  },

  deinit() {
    while (this.pending_.length) this.pending_.shift()
  },
}

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

// Using one number with bitmasks instead of multiple boolean fields saves
// significant amounts of memory.
const PENDING           = 0b00000001 | 0
const ERROR             = 0b00000010 | 0
const SUCCESS           = 0b00000100 | 0
const PENDING_REJECTION = 0b00001000 | 0
const CONSUMED          = 0b00010000 | 0
const MAPPING           = 0b00100000 | 0
const SET_ALL           = 0b11111111 | 0
const UNSET_STATE       = SET_ALL ^ (PENDING | ERROR | SUCCESS)
const SETTLED           = ERROR | SUCCESS

export function Future() {
  const self = this
  validateInstance(self, Future)
  // Note: the build system mangles properties ending with `_`.
  self.bits_        = PENDING
  self.value_       = undefined
  self.predecessor_ = undefined
  self.successor_   = undefined
  self.weaks_       = undefined
  self.mapper_      = undefined
  self.finalizer_   = undefined
}

Future.prototype = {
  constructor: Future,

  // Useful for REPL inspection and some advanced scenarios involving
  // synchronous access. Using this short-lived dictionary to check an
  // individual property appears to be very cheap in V8.
  get state() {
    const self = this
    return {
      PENDING:           someBitsSet(self, PENDING),
      ERROR:             someBitsSet(self, ERROR),
      SUCCESS:           someBitsSet(self, SUCCESS),
      PENDING_REJECTION: someBitsSet(self, PENDING_REJECTION),
      CONSUMED:          someBitsSet(self, CONSUMED),
      MAPPING:           someBitsSet(self, MAPPING),
    }
  },

  deref() {
    if (someBitsSet(this, ERROR)) {
      unsetBits(this, PENDING_REJECTION)
      throw this.value_
    }
    return this.value_
  },

  settle(error, result) {
    const self = this

    if (someBitsSet(self, SETTLED | MAPPING)) return

    if (error === self || result === self) {
      throw Error(`A future can't be chained to itself`)
    }

    if (error) result = undefined
    else error = undefined

    if (isFuture(error)) {
      // Optimization
      if (isBaseFuture(error)) {
        if (someBitsSet(error, CONSUMED)) throw Error(CONSUMABLE_ERROR)
        if (!error.successor_ && !self.mapper_) {
          self.mapper_ = alwaysThrow
          setupPredecessorSuccessorPair(error, self)
          return
        }
      }
      self.predecessor_ = error.map(function errorSettle(error, result) {
        self.settle(error || result)
      })
      return
    }

    if (isFuture(result)) {
      // Optimization
      if (isBaseFuture(result)) {
        if (someBitsSet(result, CONSUMED)) throw Error(CONSUMABLE_ERROR)
        if (!result.successor_) {
          setupPredecessorSuccessorPair(result, self)
          return
        }
      }
      self.predecessor_ = result.map(function valueSettle(error, result) {
        self.settle(error, result)
      })
      return
    }

    const mapper = self.mapper_
    self.mapper_ = undefined
    if (mapper) {
      setBits(self, MAPPING)
      try {
        result = mapper(error, result)
        error = undefined
      }
      catch (err) {
        error = err
        result = undefined
      }
      finally {
        unsetBits(self, MAPPING)
      }
      self.settle(error, result)
      return
    }

    self.value_ = error || result
    replaceStateBits(self, error ? ERROR : SUCCESS)
    if (error) setBits(self, PENDING_REJECTION)
    scheduleFuture(self)
  },

  map(mapper) {
    validate(mapper, isFunction)
    if (someBitsSet(this, CONSUMED)) throw Error(CONSUMABLE_ERROR)
    setBits(this, CONSUMED)
    unsetBits(this, PENDING_REJECTION)
    const future = new Future()
    future.mapper_ = mapper
    setupPredecessorSuccessorPair(this, future)
    return future
  },

  mapError(mapper) {
    validate(mapper, isFunction)
    return this.map(mapError.bind(null, mapper))
  },

  mapResult(mapper) {
    validate(mapper, isFunction)
    return this.map(mapResult.bind(null, mapper))
  },

  finally(mapper) {
    validate(mapper, isFunction)
    return this.map(mapFinally.bind(null, mapper))
  },

  weak() {
    const future = new Future()
    if (!this.weaks_) this.weaks_ = new Queue()
    this.weaks_.push(future)
    scheduleFuture(this)
    return future
  },

  toPromise() {
    const self = this
    if (someBitsSet(self, CONSUMED)) throw Error(CONSUMABLE_ERROR)
    unsetBits(self, PENDING_REJECTION)
    if (someBitsSet(self, ERROR)) return Promise.reject(self.value_)
    if (someBitsSet(self, SUCCESS)) return Promise.resolve(self.value_)
    return new Promise(mapFutureToPromise.bind(null, self))
  },

  catch(onError) {
    return this.toPromise().catch(onError)
  },

  then(onResult, onError) {
    return this.toPromise().then(onResult, onError)
  },

  finishPending() {
    const self = this

    if (someBitsSet(self, SETTLED)) {
      // Not expecting exceptions here
      const successor = self.successor_
      self.successor_ = undefined
      if (successor) {
        unsetBits(self, PENDING_REJECTION)
        if (someBitsSet(self, ERROR)) successor.settle(self.value_)
        else successor.settle(undefined, self.value_)
      }

      // Not expecting exceptions here
      while (self.weaks_ && self.weaks_.length) {
        const weak = self.weaks_.shift()
        if (someBitsSet(self, ERROR)) weak.settle(self.value_)
        else weak.settle(undefined, self.value_)
      }

      finalize(self)
    }

    // Problematic: obfuscates the original throw/settle site
    if (someBitsSet(self, PENDING_REJECTION)) {
      unsetBits(self, PENDING_REJECTION)
      self.constructor.onUnhandledRejection(self)
    }
  },

  deinit() {
    const self = this

    if (someBitsSet(self, MAPPING)) return

    // The mapper, if any, may replace the predecessor during `settle`. We
    // must stash the current predecessor and deinit both.

    const prevPredecessor = self.predecessor_
    self.predecessor_ = undefined

    try {
      if (!someBitsSet(self, SETTLED)) self.settle(Error(DEINIT_ERROR))
      unsetBits(self, PENDING_REJECTION)
    }
    finally {
      try {
        finalize(self)
      }
      finally {
        try {
          if (prevPredecessor) prevPredecessor.deinit()
        }
        finally {
          const nextPredecessor = self.predecessor_
          self.predecessor_ = undefined
          if (nextPredecessor) nextPredecessor.deinit()
        }
      }
    }
  },
}

Future.from = function from(error, result) {
  const future = new Future()
  future.settle(error, result)
  return future
}

Future.fromError = function fromError(error) {
  validate(error, Boolean)
  return this.from(error)
}

Future.fromResult = function fromResult(result) {
  return isFuture(result) ? result : this.from(undefined, result)
}

Future.fromPromise = function fromPromise(promise) {
  validate(promise, isPromise)
  const future = new Future()
  promise.then(future.settle.bind(future, undefined), future.settle.bind(future))
  return future
}

Future.all = function all(values) {
  validate(values, isArray)
  const future = new Future()
  initAllJuncture(new AllJuncture(future, values))
  return future
}

Future.race = function race(values) {
  validate(values, isArray)
  const future = new Future()
  initRaceJuncture(new RaceJuncture(future, values))
  return future
}

Future.onUnhandledRejection = function onUnhandledRejection(future) {
  throw future.value_  // unhandled rejection
}

Future.scheduler = new Scheduler(function finishPending(future) {
  future.finishPending()
})

/**
 * All
 */

function AllJuncture(future, values) {
  validateInstance(this, AllJuncture)
  this.future_ = future
  this.values_ = values.slice()
  this.pending_ = 0
}

AllJuncture.prototype.deinit = function deinit() {
  this.future_ = undefined
  const values = this.values_
  this.values_ = undefined
  this.pending_ = undefined
  forceDeinitFutures(values)
}

function initAllJuncture(all) {
  const values = all.values_
  const settleJuncture = settleAllJuncture.bind(null, all)

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (!isFuture(value)) continue

    // Optimization
    if (isBaseFuture(value)) {
      if (someBitsSet(value, CONSUMED)) throw Error(CONSUMABLE_ERROR)

      if (someBitsSet(value, ERROR)) {
        settleJuncture(value)
        return
      }

      if (someBitsSet(value, SUCCESS)) {
        values[i] = quietlyConsume(value)
        continue
      }

      if (!value.finalizer_) {
        setupFinalizer(value, settleAllJunctureAtIndex.bind(null, all, i))
        if (someBitsSet(value, PENDING)) all.pending_ += 1
        continue
      }
    }

    values[i] = value.map(settleAllJunctureAtIndex.bind(null, all, i))
    all.pending_ += 1
  }

  if (all.pending_) {
    // This runs when the future is settled or deinited
    all.future_.finalizer_ = all.deinit.bind(all)
  }
  else {
    settleJuncture()
  }
}

function settleAllJunctureAtIndex(all, i, error, result) {
  const values = all.values_
  if (!values) return
  all.pending_ -= 1
  if (error) {
    settleAllJuncture(all, error)
  }
  else {
    values[i] = result
    if (!all.pending_) settleAllJuncture(all)
  }
}

function settleAllJuncture(all, error) {
  const future = all.future_
  all.future_ = undefined
  const values = all.values_
  all.values_ = undefined
  if (error) {
    future.settle(error)
    forceDeinitFutures(values)
  }
  else {
    future.settle(undefined, values)
  }
}

/**
 * Race
 */

function RaceJuncture(future, values) {
  validateInstance(this, RaceJuncture)
  this.future_ = future
  this.values_ = values.slice()
  this.pending_ = 0
}

RaceJuncture.prototype.deinit = function deinit() {
  this.future_ = undefined
  const values = this.values_
  this.values_ = undefined
  this.pending_ = undefined
  forceDeinitFutures(values)
}

function initRaceJuncture(race) {
  const values = race.values_
  const settleJuncture = settleRaceJuncture.bind(null, race)

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]

    if (!isFuture(value)) {
      settleJuncture(undefined, value)
      return
    }

    // Optimization
    if (isBaseFuture(value)) {
      if (someBitsSet(value, CONSUMED)) throw Error(CONSUMABLE_ERROR)

      if (someBitsSet(value, ERROR)) {
        settleJuncture(value)
        return
      }

      if (someBitsSet(value, SUCCESS)) {
        settleJuncture(undefined, quietlyConsume(value))
        return
      }

      if (!value.finalizer_) {
        setupFinalizer(value, settleJuncture)
        if (someBitsSet(value, PENDING)) race.pending_ += 1
        continue
      }
    }

    values[i] = value.map(settleJuncture)
    race.pending_ += 1
  }

  if (race.pending_) {
    // This runs when the future is settled or deinited
    race.future_.finalizer_ = race.deinit.bind(race)
  }
  else {
    settleJuncture()
  }
}

function settleRaceJuncture(race, error, result) {
  const future = race.future_
  race.future_ = undefined
  const values = race.values_
  race.values_ = undefined
  if (!future) return
  future.settle(error, result)
  forceDeinitFutures(values)
}

/**
 * Utils
 */

// Tentative, undocumented
export function isDeinitError(value) {
  return isObject(value) && value instanceof Error && value.message === DEINIT_ERROR
}

/**
 * Internal
 */

const CONSUMABLE_ERROR = `Expected a consumable future: one that has not been mapped or passed to .settle`
const DEINIT_ERROR = 'DEINIT'

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

// Used for shortcut-style optimizations. They require instances of the base
// Future class because subclasses may break our assumptions about the
// internals.
function isBaseFuture(value) {
  return isObject(value) && value.constructor === Future
}

function validate(value, test) {
  if (!test(value)) throw Error(`Expected ${value} to satisfy test ${test.name}`)
}

function validateInstance(instance, Class) {
  if (!(instance instanceof Class)) throw Error(`Cannot call a class as a function`)
}

function forceDeinitFutures(list) {
  if (isArray(list)) forceEach(list, deinitFuture)
}

function deinitFuture(value) {
  if (isFuture(value)) value.deinit()
}

function forceEach(list, fun) {
  let error = undefined
  for (let i = 0; i < list.length; i += 1) {
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
    // `postMessage` requires an argument.
    return function asap() {channel.port2.postMessage(undefined)}
  }
  return setTimeout
}
/* eslint-enable no-restricted-globals */
