"use strict"

const fetch = require('node-fetch')
const fs = require('fs');
const url = 'https://api-pub.bitfinex.com/v2/'

const pathParams = 'ticker/tBTCUSD' // Change these based on relevant path params
const queryParams = '' // Change these based on relevant query params


var symbols = JSON.parse(fs.readFileSync('symbols.json', 'utf8'));

async function request() {
	try {
		for (var symbol of symbols) {
			const req = await fetch(`${url}ticker/t${symbol}?`);
			await new Promise(r => setTimeout(r, 1000));
			if (req.status == 200) {
				let response = await req.json();
				
				let ticker = {
					bid: response[0],
					bidSize: response[1],
					ask: response[2],
					askSize: response[3],
					dailyChange: response[4],
					dailyChangeRelative: response[5],
					lastPrice: response[6],
					volume: response[7],
					high: response[8],
					low: response[9]
				}
				
				if ((ticker.ask - ticker.bid) / ticker.ask * 100 > 2) {
					console.log(`${symbol} ${(ticker.ask - ticker.bid) / ticker.ask * 100}`);
				}
			}
		}
	} catch (err) {
		console.log(err)
	}
}

request()