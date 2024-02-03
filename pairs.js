"use strict"

const request = require('request');

const endpoint = 'https://api-pub.bitfinex.com/v2'

class Pairs {
	/*
		Query all the pairs
	*/
	static async list(type = 'exchange', filter) {
		return new Promise(async (resolve, reject) => {
			request.get(`${endpoint}/conf/pub:list:pair:${type}`, (error, response, body) => {
				// Check for errors
				if (error) {
					return reject(error);
				}

				try {
					// Try parsing response
					let pairs = JSON.parse(body);
					
					// Filter set of pairs
					if (pairs instanceof Array && pairs.length > 0 && pairs[0] instanceof Array) {
						pairs = pairs[0].filter((pair) => {
							return !filter ? true : (filter instanceof RegExp ? filter.test(pair) : new RegExp(filter).test(pair));
						});
					}
					
					// Return with the set of pairs
					resolve(pairs);
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	/*
		Query for the following data
		- minOrderSize
		- maxOrderSize
		- initialMargin
		- minMargin
	*/
	static async info() {
		return new Promise(async (resolve, reject) => {
			request.get(`${endpoint}/conf/pub:info:pair`, (error, response, body) => {
				// Check for errors
				if (error) {
					return reject(error);
				}

				try {
					let pairs = {};
					// Try parsing response
					let data = JSON.parse(body);
					data = data instanceof Array && data.length ? data[0] : data;
					
					data.forEach((item, i) => {
						pairs[item[0]] = {
							minOrderSize: Number(item[1][3]),
							maxOrderSize: Number(item[1][4]),
							initialMargin: item[1][8],
							minMargin: item[1][9]
						}
					});
					
					// Return with the set of pairs
					resolve(pairs);
				} catch (error) {
					reject(error);
				}
			});
		});
	}
}


module.exports = { Pairs }



// curl https://api-pub.bitfinex.com/v2/stats1/pos.size:1h:tBTCUSD:long/hist
// curl https://api-pub.bitfinex.com/v2/stats1/vol.1d:30m:tBTCUSD/hist
// curl https://api-pub.bitfinex.com/v2/stats1/vol.1d:30m:BFX
// curl https://api-pub.bitfinex.com/v2/stats1/vwap:1d:tBTCUSD/hist
// 
// 
// curl https://api-pub.bitfinex.com/v2/stats1/vol.1d:30m:tBTCUSD
// 
// 
// 
// curl https://api-pub.bitfinex.com/v2/candles/trade:1d:tBTCUSD/last