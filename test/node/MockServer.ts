/*!
 * Copyright (c) 2018-2023 Digital Bazaar, Inc. All rights reserved.
 */
import { httpClient } from '@interop/http-client'
import { pathToRegexp } from 'path-to-regexp'
import routeParams from 'route-params'
import { vi } from 'vitest'

/**
 * This is the vitest spy mock server.
 * It lacks some of the functionality of Pretender
 * however it can run alot of tests in node using vitest in less time.
 *
 * @class MockServer
 */
export class MockServer {
  constructor() {
    // each HTTP method maps to an ordered list of { matches, fake } handlers
    this.handlers = new Map()
    this.spies = new Map()
    this.removeStubs()
    for (const method of ['post', 'get', 'delete']) {
      const handlers = []
      this.handlers.set(method, handlers)
      const spy = vi
        .spyOn(httpClient, method)
        .mockImplementation(async (...args) => {
          const handler = handlers.find(({ matches }) => matches(args[0]))
          if (!handler) {
            throw new Error(
              `MockServer: no route registered for ${method} ${args[0]}`
            )
          }
          return handler.fake(...args)
        })
      this.spies.set(method, spy)
    }
    this.post = this.route('post')
    this.get = this.route('get')
    this.delete = this.route('delete')
  }
  // this loops through the various HTTP methods
  // and restores any spies. it makes re-stubbing across test runs possible
  removeStubs() {
    const methods = ['post', 'get', 'delete', 'put', 'options', 'head', 'patch']
    methods.forEach(method => {
      const fn = httpClient[method]
      if (fn && typeof fn.mockRestore === 'function') {
        fn.mockRestore()
      }
    })
  }
  /**
   * @description This is the core of the vitest mock server.
   * It registers a route handler that matches a request URL against a regex
   * and runs an async function that produces the mock data for a test.
   *
   * @param {string} method - The HTTP method to register the route on.
   *
   * @returns {Function} A function that will allow other services
   * should as mock storage and mock kms to setup test data.
   */
  route(method) {
    const handlers = this.handlers.get(method)
    /**
     * This is a function curried to a method's handler list.
     *
     * @param {string} path - A valid express route path ex: edvs/:id.
     * @param {Function} callback - A function that accepts the route params
     * and then produces mock data for a test.
     *
     * @returns {void}
     */
    return function (path, callback) {
      // routes are full URLs
      const url = new URL(path)
      const { regexp: pathRegex } = pathToRegexp(url.pathname)
      // match origin and pathname regex
      const matches = value => {
        const valueUrl = new URL(value)
        return (
          valueUrl.origin === url.origin && pathRegex.test(valueUrl.pathname)
        )
      }
      const fake = async function (route, body) {
        const params = routeParams(path, route)
        const queryParams = body && body.searchParams ? body.searchParams : {}
        const { headers } = body ? body : { headers: {} }
        const parsedSearchParams = new URL(route).searchParams
        for (const [key, value] of parsedSearchParams) {
          queryParams[key] = String(value)
        }
        for (const [key, value] of Object.entries(queryParams)) {
          queryParams[key] = String(value)
        }
        const request = {
          route,
          requestBody: JSON.stringify(body),
          headers,
          params,
          queryParams
        }
        const result = await callback(request)
        // the first argument from a handler is the statusCode in express.
        const [status] = result
        if (status > 300) {
          const error = new Error('A HTTP error occurred.')
          error.response = {
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({}),
            data: {},
            status
          }
          error.status = status
          switch (status) {
            case 404:
              error.name = 'NotFoundError'
              throw error
            case 409:
              error.name = 'DuplicateError'
              throw error
            default:
              throw error
          }
        }

        let [, responseHeaders] = result
        responseHeaders = responseHeaders || new Map()
        responseHeaders.set('content-type', 'application/json')
        // this might look weird, but express really does
        // reserve the last argument from a handler for the data.
        // this formats that data into a http response
        const data = result[result.length - 1]
        return {
          headers: responseHeaders,
          json: async () => data,
          data,
          status
        }
      }
      handlers.push({ matches, fake })
    }
  }
  shutdown() {
    return true
  }
  prepareHeaders() {
    return true
  }
  prepareBody() {
    return true
  }
}
