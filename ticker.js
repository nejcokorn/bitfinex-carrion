const EventEmitter = require('events');
const { PublicBitfinex } = require('./bitfinex');

class Ticker extends EventEmitter {
	constructor(pair) {
		super();

		this.pair = pair;
		this.channel = "ticker";
		this.channelId = null;

		// Initialize properties
		this.bid = null;
		this.bidSize = null;
		this.ask = null;
		this.askSize = null;
		this.dailyChange = null;
		this.dailyChangeRelative = null;
		this.lastPrice = null;
		this.volume = null;
		this.high = null;
		this.low = null;
	}

	async subscribe() {
		return new Promise(async (resolve, reject) => {
			// Listen for events
			this.connection = await PublicBitfinex.connect();
			this.connection.on('data', (data) => {
				try {
					data = JSON.parse(data);
					if (data instanceof Array) {
						this.processData(data);
					} else if (data instanceof Object) {
						if (data.event == 'subscribed' && this.channel == data.channel && this.channelId == null && this.pair == data.pair) {
							this.channelId = data.chanId;
							resolve();
						}
					}
				} catch (error) {
					console.log(error);
					resolve(error);
				}
			});

			this.connection.on('error', (error) => {
				if (error.event == 'error' && this.channel == error.channel && this.pair == error.pair) {
					switch (error.code) {
						case 10301:
							// Duplicated subscription
							// TODO unsubscribe first
							this.channelId = error.chanId;
							resolve();
							break;
						default:
							console.log(error);
							resolve(error);
					}
				}
			});

			this.connection.on('disconnected', (error) => {
				this.channelId = null;
				this.subscribe();
			});

			// Options for subscribe event
			let subscribeOptions = {
				event: 'subscribe',
				channel: this.channel,
				symbol: `t${this.pair}`
			};

			// Subscribe to the ticker
			this.connection.emit('subscribe', subscribeOptions);
		});
	}

	processData(data) {
		let channelId = data.shift();
		if (this.channelId != channelId) {
			return;
		}

		// Extract first element
		data = data[0];

		// Skip if no data
		if (data.length == 0) {
			return;
		}

		// Link array values to properties
		if (data instanceof Array) {
			this.bid = data[0];
			this.bidSize = data[1];
			this.ask = data[2];
			this.askSize = data[3];
			this.dailyChange = data[4];
			this.dailyChangeRelative = data[5];
			this.lastPrice = data[6];
			this.volume = data[7];
			this.high = data[8];
			this.low = data[9];
		}

		this.emit("change", {
			pair: this.pair,
			bid: data[0],
			bidSize: data[1],
			ask: data[2],
			askSize: data[3],
			dailyChange: data[4],
			dailyChangeRelative: data[5],
			lastPrice: data[6],
			volume: data[7],
			high: data[8],
			low: data[9]
		});
	}

	get() {
		return {
			bid: this.bid,
			bidSize: this.bidSize,
			ask: this.ask,
			askSize: this.askSize,
			dailyChange: this.dailyChange,
			dailyChangeRelative: this.dailyChangeRelative,
			lastPrice: this.lastPrice,
			volume: this.volume,
			high: this.high,
			low: this.low
		}
	}
}

module.exports = {
	Ticker
}
