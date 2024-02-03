const EventEmitter = require('events');
const { PublicBitfinex } = require('./bitfinex');

class Book extends EventEmitter {
	constructor(pair) {
		super();

		this.pair = pair;
		this.channel = "book";
		this.channelId = null;

		this.asks = [];
		this.bids = [];
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

		// Extract first element of the array
		data = data instanceof Array && data.length ? data[0] : [];

		// Skip if no data found
		if (data.length == 0) {
			return;
		}

		if (data[0] instanceof Array) {
			// Parse snapshot
			for (var item of data) {
				if (item[2] > 0) {
					this.processBid(item);
				} else {
					this.processAsk(item);
				}
			}
		} else {
			// Parse update
			if (data[2] > 0) {
				this.processBid(data);
			} else {
				this.processAsk(data);
			}
		}
	}

	processAsk(data) {
		// Remove existing
		this.asks = this.asks.filter((item) => {
			return data[0] != item.price;
		});
		// Add new
		if (data[1] > 0) {
			let ask = {
				price: data[0],
				count: data[1],
				amount: data[2]
			}
			this.asks.push(ask);
			this.emit("change", ask);
		}
		// Reorder
		this.asks.sort((a, b) => {
			return a.price - b.price;
		});
	}

	processBid(data) {
		// Remove existing
		this.bids = this.bids.filter((item) => {
			return data[0] != item.price;
		});
		// Add new
		if (data[1] > 0) {
			let bid = {
				price: data[0],
				count: data[1],
				amount: data[2]
			}
			this.bids.push(bid);
			this.emit("change", bid);
		}
		// Reorder
		this.bids.sort((a, b) => {
			return b.price - a.price;
		});
	}
}

module.exports = {
	Book
}
