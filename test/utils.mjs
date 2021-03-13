import {AssertionError} from 'assert'
import {inspect} from 'util'
import * as e from 'emerge'

export function is(actual, expected, message) {
  if (!e.is(actual, expected)) {
    throw new AssertionError({actual, expected, operator: `is`, stackStartFunction: is, message})
  }
}

export function eq(actual, expected, message) {
  if (!e.equal(actual, expected)) {
    throw new AssertionError({actual, expected, operator: `eq`, stackStartFunction: eq, message})
  }
}

// Must be awaited on.
export async function throws(fun, messageOrClass) {
  if (!isFunction(fun)) {
    throw new AssertionError({message: `expected a function, got ${show(fun)}`})
  }
  if (!messageOrClass) {
    throw new AssertionError({
      message: `expected an error message or class, got ${show(messageOrClass)}`,
    })
  }
  try {
    await fun()
  }
  catch (err) {
    if (isFunction(messageOrClass)) {
      if (!(err instanceof messageOrClass)) {
        throw new AssertionError({
          message: `expected ${show(fun)} to throw an instance of ${show(messageOrClass)}, got ${show(err)}`,
          stackStartFunction: throws,
        })
      }
    }
    else if (!err || !(err instanceof Error) || !err.message.match(messageOrClass)) {
      throw new AssertionError({
        message: (
          `expected ${show(fun)} to throw an error with a message matching ` +
          `${show(messageOrClass)}, got ${show(err)}`
        ),
        stackStartFunction: throws,
      })
    }
    return
  }
  throw new AssertionError({
    message: `expected ${show(fun)} to throw`,
    stackStartFunction: throws,
  })
}

function show(value) {
  return isFunction(value) && !value.name
    ? value.toString()
    : inspect(value, {breakLength: Infinity})
}

function isFunction(value) {
  return typeof value === 'function'
}

export function runWithTimeout(fun) {
  const timer = setTimeout(timeoutPanic, 512)
  return fun().then(clearTimeout.bind(undefined, timer), panic)
}

function timeoutPanic() {
  panic(Error(`test timeout`))
}

export function panic(err) {
  console.error(`fatal error:`, err)
  process.exit(1)
}

export function noop() {}
