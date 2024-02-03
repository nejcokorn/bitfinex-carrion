const fs = require('fs');
const arg = require('arg');
const { Pairs } = require('./pairs');
const { Ticker } = require('./ticker');
const { Trades } = require('./trades');
const { Carrion } = require('./carrion');
const { Book } = require('./book');

(async () => {

	// Read arguments
	const args = arg({
		// Types
		'--config': String,

		// Aliases
		'-c':        '--config'
	});

	// Load configuration from file
	var config = JSON.parse(fs.readFileSync(args['--config'], 'utf8'));

	// Set API key and API secret
	process.env.BITFINEX_API_KEY = config.apiKey;
	process.env.BITFINEX_API_SECRET = config.apiSecret;

	// Start all pairs
	for (var item of config.pairs) {
		item.buy = config.buy && item.buy ? true : false;
		item.sell = config.sell && item.sell ? true : false;

		// Skip if no action to buy or sell
		if (item.buy == false && item.sell == false) {
			continue;
		}

		try {
			let carrion = new Carrion(item);
			await carrion.init();
		} catch (e) {
			console.log(e);
		}
	}

})();
