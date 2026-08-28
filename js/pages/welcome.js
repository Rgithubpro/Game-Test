Router.register('welcome', (() => {
    function sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

    return {
        async start() {
            const { syncAssets, applyAssetAttributes } = await import('/js/data/cache.js');
            const result = await syncAssets({ onProgress: (pct, detail) => {} });
            if (result.status === 'failed') {
                console.warn('welcome: asset sync failed', result);
            }
            await applyAssetAttributes(); // fills every [data-asset] element now in the DOM for this page
            
        },
        stop() {}
    };
})());