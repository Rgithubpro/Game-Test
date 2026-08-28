Router.register('loading', (() => {
	let _running = false;
	let _titleInterval = null;

	function sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	async function edit_loading_percentage(target) {
		const loading_percentage = document.getElementById('loading-screen-percentage');
		if (!loading_percentage) return;
		while (_running) {
			let current_percentage = parseFloat(loading_percentage.textContent) || 0;
			if (current_percentage >= target) break;
			loading_percentage.textContent = (current_percentage + 1) + '%';
			await sleep(8);
		}
	}

	async function edit_loading_detail(target) {
		const loading_detail = document.getElementById('loading-screen-detail');
		if (!loading_detail) return;
		loading_detail.textContent = target;
	}

	function set_loading_bar(pct) {
		const loading_bar = document.getElementById('loading-screen-bar-fill');
		if (loading_bar) loading_bar.style.width = pct + '%';
	}

	// Shown when syncAssets() has exhausted its retries. Reuses the
	// existing #loading-screen-notification block (same one used for
	// the "loading_notif" announcement above) rather than inventing a
	// second notification UI.
	function show_failure_notice(reportUrl) {
		const notif = document.getElementById('loading-screen-notification');
		const img = document.getElementById('loading-screen-notification-img');
		if (!notif) return;

		document.getElementById('loading-screen-notification-title').textContent = 'Couldn\'t load game assets';
		document.getElementById('loading-screen-notification-description').textContent =
			'Please try reloading the page. If this keeps happening, let us know on GitHub so we can look into it.';
		document.getElementById('loading-screen-notification-time').textContent = '';
		if (img) { img.removeAttribute('src'); img.style.display = 'none'; }

		notif.hidden = false;
		document.body.classList.add('has-notification');

		// Make the description a link to the report URL, if present.
		if (reportUrl) {
			const desc = document.getElementById('loading-screen-notification-description');
			desc.innerHTML =
				'Please try reloading the page. If this keeps happening, ' +
				`<a href="${reportUrl}" target="_blank" rel="noopener">report it on GitHub</a>.`;
		}
	}

	return {
		async start() {
			if (_running) return;
			_running = true;

			const loading_screen = document.getElementById('loading-screen');

			// Notification block (may short-circuit the rest)
			try {
				const { loading_notif } = await import('/js/data/database/extra.js');
				const [notifEnabled, notifTitle, notifDesc, notifTime, notifImage] = await loading_notif();
				const notif = document.getElementById('loading-screen-notification');
				const img   = document.getElementById('loading-screen-notification-img');
				if (notif && notifEnabled === true) {
					document.getElementById('loading-screen-notification-title').textContent = notifTitle || '';
					document.getElementById('loading-screen-notification-description').textContent = notifDesc || '';
					document.getElementById('loading-screen-notification-time').textContent = notifTime || '';
					if (notifImage) {
						img.src = notifImage;
						img.style.display = 'block';
					} else {
						img.removeAttribute('src');
						img.style.display = 'none';
					}
					notif.hidden = false;
					document.body.classList.add('has-notification');
					_running = false;
					return;
				} else if (notif) {
					notif.hidden = true;
					document.body.classList.remove('has-notification');
				}
			} catch (err) {
				console.error('loading: failed to load notification data', err);
			}

			const title = document.getElementById('loading-screen-title');
			const states = ['', '.', '..', '...', '..', '.'];
			let idx = 0;

			_titleInterval = setInterval(() => {
				if (title) title.textContent = 'Loading' + states[idx];
				idx = (idx + 1) % states.length;

				if (loading_screen && loading_screen.style.display === 'none') {
					clearInterval(_titleInterval);
					_titleInterval = null;
					if (title) title.textContent = 'Loading';
					_running = false;
				}
			}, 400);

			edit_loading_detail('Initializing...');
			set_loading_bar(2);
			edit_loading_percentage(2);

			// --- Real asset sync ---
			// syncAssets() already retries internally (see cache.js
			// MAX_ATTEMPTS) and logs to Supabase on final failure.
			// Here we just react to the result.
			let syncResult;
			try {
				const { syncAssets } = await import('/js/data/cache.js');
				syncResult = await syncAssets({
					onProgress: (pct, detail) => {
						if (!_running) return;
						if (typeof pct === 'number') {
							set_loading_bar(pct);
							edit_loading_percentage(pct);
						}
						if (detail) edit_loading_detail(detail);
					},
				});
			} catch (err) {
				// Shouldn't normally happen — syncAssets() catches its own
				// errors — but guard anyway so a bug in cache.js can't hang
				// the loading screen forever.
				console.error('loading: unexpected error from syncAssets', err);
				syncResult = { status: 'failed', reportUrl: 'https://github.com/Rgithubpro/apex-arena' };
			}

			if (syncResult.status === 'failed') {
				if (_titleInterval) { clearInterval(_titleInterval); _titleInterval = null; }
				_running = false;
				show_failure_notice(syncResult.reportUrl);
				return;
			}

			if (!_running) return;
			set_loading_bar(100);
			edit_loading_detail('Launching...');
			edit_loading_percentage(100);
			await sleep(500);

			if (!_running) return;
			try {
				const { get_logged_in } = await import('/js/data/localstorage.js');
				if (await get_logged_in() === true) {
					Router.go('home');
				} else {
					Router.go('welcome');
				}
			} catch (err) {
				console.error('loading: failed to check login state', err);
				Router.go('welcome');
			}
		},

		stop() {
			if (_titleInterval) {
				clearInterval(_titleInterval);
				_titleInterval = null;
			}
			_running = false;
		}
	};
})());