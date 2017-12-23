'use strict'
const _ = require('lodash')
const moment = require('moment')
const request = require('co-request')
const { codes, createIlpRejection } = require('./ilp-errors')

/**
 * In atomic mode, transfers shouldn't have an `expires_at` property.
 * The notary Case has one, which guarantees that either all of the payment's
 * transfers expire or none do.
 *
 * In universal mode, each transfer has an `expires_at`.
 * Successive transfers' expiries should decrease. The first transfer in a
 * payment has the latest expiry; the final transfer in the payment should
 * expire first.
 *
 * `minMessageWindow` is the minimum time that the connector needs to execute
 *   a transfer. The difference in expiries of successive transfers must be
 *   greater than or equal to this value.
 * `maxHoldTime` is the maximum duration that the connector is willing to place
 *   funds on hold while waiting for the outcome of a transaction. No expiry can
 *   exceed this value.
 */
module.exports = async function (config, sourceTransfer, destinationTransfer) {
  const tester = new TransferTester(config, sourceTransfer, destinationTransfer)
  await tester.loadCaseExpiries()
  return tester
}

function TransferTester (config, sourceTransfer, destinationTransfer) {
  this.config = config
  this.sourceTransfer = sourceTransfer
  this.destinationTransfer = destinationTransfer
  this.transfers = [sourceTransfer, destinationTransfer]
  this.expiryByCase = {}
  this.createIlpRejection = createIlpRejection.bind(null, config.address)

  // TODO use a more intelligent value for the minMessageWindow
  this.minMessageWindow = config.getIn(['expiry', 'minMessageWindow']) * 1000
  this.maxHoldTime = config.getIn(['expiry', 'maxHoldTime']) * 1000
}

TransferTester.prototype.getExpiry = function (transfer) {
  if (transfer.expiresAt) return transfer.expiresAt
  const expiries = _.uniq(_.values(_.pick(
    this.expiryByCase, getTransferCases(transfer))))
  if (expiries.length === 0) return undefined
  if (expiries.length === 1) return expiries[0]
  throw this.createIlpRejection({
    code: codes.F00_BAD_REQUEST,
    message: 'Case expiries don\'t agree'
  })
}

TransferTester.prototype.isAtomic = function () {
  return getTransferCases(this.sourceTransfer).length > 0
}

// /////////////////////////////////////////////////////////////////////////////
// All
// /////////////////////////////////////////////////////////////////////////////

// Verify that none of the transfers have already expired
TransferTester.prototype.validateNotExpired = function () {
  {
    const expiresAt = this.getExpiry(this.sourceTransfer)
    if (expiresAt && moment(expiresAt, moment.ISO_8601).isBefore(moment())) {
      throw this.createIlpRejection({
        code: codes.R02_INSUFFICIENT_TIMEOUT,
        message: 'Transfer has already expired'
      })
    }
  }
  {
    const expiresAt = this.getExpiry(this.destinationTransfer)
    if (expiresAt && moment(expiresAt, moment.ISO_8601).isBefore(moment())) {
      throw this.createIlpRejection({
        code: codes.R02_INSUFFICIENT_TIMEOUT,
        message: 'Not enough time to send payment'
      })
    }
  }
}

// /////////////////////////////////////////////////////////////////////////////
// Non-Atomic
// /////////////////////////////////////////////////////////////////////////////

// If the destination transfer(s) have execution condition(s)
// we need to make sure we're not being asked
// to hold money for too long
TransferTester.prototype.validateMaxHoldTime = function () {
  const expiresAt = this.getExpiry(this.destinationTransfer)
  // A missing expiry is nothing to worry about in optimistic mode.
  if (!expiresAt && !this.destinationTransfer.executionCondition) return

  if (expiresAt) {
    this.validateExpiryHoldTime(expiresAt)
  } else {
    throw this.createIlpRejection({
      code: codes.F00_BAD_REQUEST,
      message: 'Destination transfers with ' +
        'execution conditions must have an expires_at field for connector ' +
        'to agree to authorize them'
    })
  }
}

TransferTester.prototype.validateExpiryHoldTime = function (expiresAt) {
  if (moment(expiresAt, moment.ISO_8601).diff(moment()) > this.maxHoldTime) {
    throw this.createIlpRejection({
      code: codes.R02_INSUFFICIENT_TIMEOUT,
      message: 'Destination transfer expiry is ' +
        "too far in the future. The connector's money would need to be " +
        'held for too long'
    })
  }
}

// /////////////////////////////////////////////////////////////////////////////
// Atomic
// /////////////////////////////////////////////////////////////////////////////

TransferTester.prototype.loadCaseExpiries = async function () {
  for (const transfer of this.transfers) {
    if (transfer.expiresAt) continue
    const caseIDs = getTransferCases(transfer)
    for (const caseID of caseIDs) {
      await this.loadCaseExpiry(caseID)
    }
  }
}

// TODO check if the notary is trusted
TransferTester.prototype.loadCaseExpiry = async function (caseID) {
  if (this.expiryByCase[caseID]) return

  const caseRes = await request({
    method: 'get',
    uri: caseID,
    json: true
  })
  if (caseRes.statusCode !== 200) {
    throw this.createIlpRejection({
      code: codes.T00_INTERNAL_ERROR,
      message: 'Unexpected remote error: ' + caseRes.statusCode + ' ' + caseRes.body
    })
  }
  const expiry = caseRes.body.expires_at
  if (expiry) {
    this.expiryByCase[caseID] = expiry
  } else {
    throw this.createIlpRejection({
      code: codes.F00_BAD_REQUEST,
      message: 'Cases must have an expiry.'
    })
  }
}

function getTransferCases (transfer) {
  return transfer.cases || []
}
