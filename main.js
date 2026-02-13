/**
 * CategoryDiffusion — Wikimedia Commons user script
 *
 * Helps editors diffuse overfull categories by suggesting appropriate
 * subcategories for each file, using an LLM via a Cloudflare Worker proxy.
 *
 * All Commons API work (tree crawl, file metadata) runs in the browser.
 * Only LLM calls go through the external Worker.
 *
 * Install: add the following to your common.js on Commons:
 *   importScript('User:Alaexis/Diffusor.js');
 */
( function () {
	'use strict';

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------
	var CONFIG = {
		// URL of your Cloudflare Worker that proxies LLM requests
		llmProxyUrl: 'https://publicai-proxy.alaexis.workers.dev',
		llmModel: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
		llmMaxTokens: 2048,
		llmTemperature: 0.1,

		// Editing
		// If true, saves edits via the API (with an optional tag) instead of
		// just opening the edit form. By default this is false so users always
		// review the diff manually.
		useApiEdit: false,

		// Subcategory tree crawl limits
		maxTreeDepth: 5,
		maxTreeNodes: 2000,

		// LLM batching
		filesPerBatch: 20,
		maxFilesPerCategory: 200,

		// UI
		panelWidth: '420px',
		localStoragePrefix: 'catdiffusion-'
	};

	// Allow user overrides
	if ( window.CategoryDiffusionConfig ) {
		$.extend( CONFIG, window.CategoryDiffusionConfig );
	}

	// -----------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------
	var state = {
		categoryTitle: mw.config.get( 'wgPageName' ),
		analysisStatus: 'idle',   // idle | running | done | error
		suggestions: {},          // { "File:Foo.jpg": ["Cat1","Cat2"], ... }
		reviewedFiles: {},        // { "File:Foo.jpg": true, ... }
		currentFile: null,        // file title currently shown in panel
		subcategories: [],        // flat list of subcategory titles (without "Category:")
		fileMetadata: {}          // { "File:Foo.jpg": { description, categories }, ... }
	};

	// -----------------------------------------------------------------------
	// CSS
	// -----------------------------------------------------------------------
	function injectStyles() {
		var css = [

			/* Per-thumbnail suggest buttons */
			'.catdiff-suggest-btn {',
			'  display: inline-block;',
			'  margin-top: 4px;',
			'  padding: 2px 8px;',
			'  font-size: 11px;',
			'  background: #36c;',
			'  color: #fff;',
			'  border: none;',
			'  border-radius: 3px;',
			'  cursor: pointer;',
			'}',
			'.catdiff-suggest-btn:hover { background: #2a4b8d; }',
			'.catdiff-suggest-btn:disabled {',
			'  background: #aaa;',
			'  cursor: not-allowed;',
			'}',
			'.catdiff-suggest-btn.catdiff-reviewed {',
			'  background: #72777d;',
			'}',
			'.catdiff-suggest-btn.catdiff-reviewed::after {',
			'  content: " \\2713";',
			'}',
			'.catdiff-suggest-btn.catdiff-has-suggestions {',
			'  background: #14866d;',
			'}',

			/* Gallery item reviewed overlay */
			'.catdiff-gallery-reviewed {',
			'  opacity: 0.55;',
			'}',

			/* Right-side panel */
			'#catdiff-panel {',
			'  display: none;',
			'  position: fixed;',
			'  top: 0;',
			'  right: 0;',
			'  width: ' + CONFIG.panelWidth + ';',
			'  height: 100vh;',
			'  background: #fff;',
			'  border-left: 2px solid #a2a9b1;',
			'  box-shadow: -3px 0 12px rgba(0,0,0,0.15);',
			'  z-index: 10000;',
			'  overflow-y: auto;',
			'  padding: 16px;',
			'  box-sizing: border-box;',
			'  font-size: 13px;',
			'}',
			'#catdiff-panel.catdiff-panel-open {',
			'  display: block;',
			'}',

			/* Panel header */
			'#catdiff-panel-close {',
			'  float: right;',
			'  background: none;',
			'  border: none;',
			'  font-size: 20px;',
			'  cursor: pointer;',
			'  color: #555;',
			'  line-height: 1;',
			'}',
			'#catdiff-panel-close:hover { color: #d33; }',

			'#catdiff-panel h3 {',
			'  margin: 0 0 12px 0;',
			'  font-size: 15px;',
			'  border-bottom: 1px solid #c8ccd1;',
			'  padding-bottom: 8px;',
			'}',

			/* Panel thumbnail */
			'#catdiff-panel-thumb {',
			'  max-width: 100%;',
			'  max-height: 200px;',
			'  display: block;',
			'  margin: 8px auto;',
			'  border: 1px solid #c8ccd1;',
			'}',

			/* Panel sections */
			'.catdiff-section {',
			'  margin: 12px 0;',
			'}',
			'.catdiff-section-title {',
			'  font-weight: bold;',
			'  margin-bottom: 4px;',
			'  color: #222;',
			'}',

			/* Description */
			'#catdiff-description {',
			'  max-height: 120px;',
			'  overflow-y: auto;',
			'  background: #f8f9fa;',
			'  padding: 6px 8px;',
			'  border-radius: 3px;',
			'  font-size: 12px;',
			'  white-space: pre-wrap;',
			'  word-break: break-word;',
			'}',

			/* Current categories list */
			'#catdiff-current-cats {',
			'  list-style: none;',
			'  padding: 0;',
			'  margin: 4px 0;',
			'}',
			'#catdiff-current-cats li {',
			'  padding: 2px 0;',
			'  color: #555;',
			'  font-size: 12px;',
			'}',
			'#catdiff-current-cats li::before {',
			'  content: "\\2022 ";',
			'  color: #999;',
			'}',

			/* Suggested categories checkboxes */
			'#catdiff-suggestions-list {',
			'  list-style: none;',
			'  padding: 0;',
			'  margin: 4px 0;',
			'}',
			'#catdiff-suggestions-list li {',
			'  padding: 3px 0;',
			'}',
			'#catdiff-suggestions-list label {',
			'  cursor: pointer;',
			'}',
			'#catdiff-suggestions-list label.catdiff-already-present {',
			'  color: #999;',
			'  text-decoration: line-through;',
			'}',

			/* Suggestion count */
			'#catdiff-suggestion-count {',
			'  font-size: 11px;',
			'  color: #72777d;',
			'  margin-top: 4px;',
			'}',

			/* Panel action buttons */
			'.catdiff-actions {',
			'  margin-top: 16px;',
			'  display: flex;',
			'  gap: 8px;',
			'}',
			'.catdiff-btn-accept {',
			'  flex: 1;',
			'  padding: 8px;',
			'  background: #14866d;',
			'  color: #fff;',
			'  font-weight: bold;',
			'  border: none;',
			'  border-radius: 4px;',
			'  cursor: pointer;',
			'  font-size: 13px;',
			'}',
			'.catdiff-btn-accept:hover { background: #0d6b56; }',
			'.catdiff-btn-reject {',
			'  flex: 1;',
			'  padding: 8px;',
			'  background: #fff;',
			'  color: #555;',
			'  font-weight: bold;',
			'  border: 1px solid #a2a9b1;',
			'  border-radius: 4px;',
			'  cursor: pointer;',
			'  font-size: 13px;',
			'}',
			'.catdiff-btn-reject:hover { background: #f0f0f0; }',

			/* Loading spinner */
			'.catdiff-loading {',
			'  text-align: center;',
			'  padding: 24px;',
			'  color: #72777d;',
			'}',

			/* Progress status */
			'#catdiff-progress-status {',
			'  margin: 8px 0;',
			'  line-height: 1.5;',
			'  color: #222;',
			'}',
			'#catdiff-progress-stages {',
			'  margin-top: 12px;',
			'}',

			/* Push content left when panel is open */
			'body.catdiff-panel-active #mw-content-text {',
			'  margin-right: ' + CONFIG.panelWidth + ';',
			'}'
		].join( '\n' );

		$( '<style>' ).text( css ).appendTo( 'head' );
	}

	// -----------------------------------------------------------------------
	// LocalStorage helpers
	// -----------------------------------------------------------------------
	function getStorageKey( suffix ) {
		return CONFIG.localStoragePrefix + state.categoryTitle + '-' + suffix;
	}

	function loadReviewedState() {
		try {
			var raw = localStorage.getItem( getStorageKey( 'reviewed' ) );
			if ( raw ) {
				state.reviewedFiles = JSON.parse( raw );
			}
		} catch ( e ) {
			state.reviewedFiles = {};
		}
	}

	function saveReviewedState() {
		try {
			localStorage.setItem(
				getStorageKey( 'reviewed' ),
				JSON.stringify( state.reviewedFiles )
			);
		} catch ( e ) {
			// localStorage may be full or unavailable
		}
	}

	function loadCachedSuggestions() {
		try {
			var raw = localStorage.getItem( getStorageKey( 'suggestions' ) );
			if ( raw ) {
				var parsed = JSON.parse( raw );
				state.suggestions = parsed.suggestions || {};
				state.subcategories = parsed.subcategories || [];
				state.fileMetadata = parsed.fileMetadata || {};
				state.analysisStatus = 'done';
				return true;
			}
		} catch ( e ) {
			// ignore
		}
		return false;
	}

	function saveCachedSuggestions() {
		try {
			localStorage.setItem(
				getStorageKey( 'suggestions' ),
				JSON.stringify( {
					suggestions: state.suggestions,
					subcategories: state.subcategories,
					fileMetadata: state.fileMetadata
				} )
			);
		} catch ( e ) {
			// ignore
		}
	}

	// -----------------------------------------------------------------------
	// Commons API: subcategory tree crawl
	// -----------------------------------------------------------------------
	function fetchDirectSubcategories( categoryTitle ) {
		var api = new mw.Api();
		var allSubcats = [];

		function fetchPage( cmcontinue ) {
			var params = {
				action: 'query',
				list: 'categorymembers',
				cmtitle: categoryTitle,
				cmtype: 'subcat',
				cmlimit: 500,
				format: 'json'
			};
			if ( cmcontinue ) {
				params.cmcontinue = cmcontinue;
			}
			return api.get( params ).then( function ( data ) {
				var members = data.query.categorymembers || [];
				var i, len;
				for ( i = 0, len = members.length; i < len; i++ ) {
					allSubcats.push( members[ i ].title );
				}
				if ( data[ 'continue' ] && data[ 'continue' ].cmcontinue ) {
					return fetchPage( data[ 'continue' ].cmcontinue );
				}
				return allSubcats;
			} );
		}

		return fetchPage( null );
	}

	function crawlSubcategoryTree() {
		var deferred = $.Deferred();
		var allSeen = {};
		var currentLevel = [ state.categoryTitle ];
		var depth = 0;

		function processLevel() {
			depth++;
			if ( depth > CONFIG.maxTreeDepth || currentLevel.length === 0 ) {
				var result = Object.keys( allSeen );
				result.sort();
				deferred.resolve( result );
				return;
			}

			var nextLevel = [];
			var idx = 0;
			var total = currentLevel.length;

			function processNext() {
				if ( idx >= total ) {
					currentLevel = nextLevel;
					updateStatus(
						'Depth ' + depth + ' done: ' +
						Object.keys( allSeen ).length + ' subcategories found…'
					);
					processLevel();
					return;
				}

				var cat = currentLevel[ idx ];
				idx++;

				updateStatus(
					'Depth ' + depth + ': expanding ' + idx + '/' + total +
					' (' + Object.keys( allSeen ).length + ' subcats so far)…'
				);

				fetchDirectSubcategories( cat ).then( function ( subcats ) {
					var i, len, s;
					for ( i = 0, len = subcats.length; i < len; i++ ) {
						s = subcats[ i ];
						if ( !allSeen[ s ] && s !== state.categoryTitle ) {
							allSeen[ s ] = true;
							nextLevel.push( s );
							if ( Object.keys( allSeen ).length >= CONFIG.maxTreeNodes ) {
								currentLevel = [];
								var result = Object.keys( allSeen );
								result.sort();
								deferred.resolve( result );
								return;
							}
						}
					}
					processNext();
				}, function ( err ) {
					// Skip failures, continue
					mw.log.warn( 'CategoryDiffusion: failed to expand ' + cat, err );
					processNext();
				} );
			}

			processNext();
		}

		processLevel();
		return deferred.promise();
	}

	// -----------------------------------------------------------------------
	// Commons API: file listing + metadata
	// -----------------------------------------------------------------------
	function fetchCategoryFiles() {
		var api = new mw.Api();
		var allFiles = [];

		function fetchPage( cmcontinue ) {
			var params = {
				action: 'query',
				list: 'categorymembers',
				cmtitle: state.categoryTitle,
				cmtype: 'file',
				cmlimit: 500,
				format: 'json'
			};
			if ( cmcontinue ) {
				params.cmcontinue = cmcontinue;
			}
			return api.get( params ).then( function ( data ) {
				var members = data.query.categorymembers || [];
				var i, len;
				for ( i = 0, len = members.length; i < len; i++ ) {
					allFiles.push( members[ i ].title );
				}
				if ( allFiles.length >= CONFIG.maxFilesPerCategory ) {
					allFiles = allFiles.slice( 0, CONFIG.maxFilesPerCategory );
					return allFiles;
				}
				if ( data[ 'continue' ] && data[ 'continue' ].cmcontinue ) {
					return fetchPage( data[ 'continue' ].cmcontinue );
				}
				return allFiles;
			} );
		}

		return fetchPage( null );
	}

	function fetchFileDescriptions( fileTitles ) {
		var api = new mw.Api();
		var result = {};
		var chunks = [];
		var i;

		// Split into chunks of 50 (MediaWiki API limit)
		for ( i = 0; i < fileTitles.length; i += 50 ) {
			chunks.push( fileTitles.slice( i, i + 50 ) );
		}

		var chunkIdx = 0;

		function processChunk() {
			if ( chunkIdx >= chunks.length ) {
				return $.Deferred().resolve( result ).promise();
			}

			var chunk = chunks[ chunkIdx ];
			chunkIdx++;

			updateStatus(
				'Fetching file metadata: batch ' + chunkIdx + '/' + chunks.length + '…'
			);

			return api.get( {
				action: 'query',
				titles: chunk.join( '|' ),
				prop: 'revisions|categories',
				rvprop: 'content',
				rvslots: 'main',
				cllimit: 'max',
				format: 'json'
			} ).then( function ( data ) {
				var pages = data.query.pages || {};
				var pageId, page, title, wikitext, rev, cats, j, jLen;

				for ( pageId in pages ) {
					if ( !pages.hasOwnProperty( pageId ) || pageId === '-1' ) {
						continue;
					}
					page = pages[ pageId ];
					title = page.title || '';
					if ( !title ) {
						continue;
					}

					// Extract wikitext
					wikitext = '';
					if ( page.revisions && page.revisions[ 0 ] ) {
						rev = page.revisions[ 0 ];
						if ( rev.slots && rev.slots.main ) {
							wikitext = rev.slots.main[ '*' ] || rev.slots.main.content || '';
						} else if ( rev[ '*' ] ) {
							wikitext = rev[ '*' ];
						}
					}

					// Extract categories
					cats = [];
					if ( page.categories ) {
						for ( j = 0, jLen = page.categories.length; j < jLen; j++ ) {
							cats.push( page.categories[ j ].title.replace( /^Category:/, '' ) );
						}
					}

					result[ title ] = {
						description: extractDescription( wikitext ),
						categories: cats
					};
				}

				return processChunk();
			}, function () {
				// Skip failed chunk
				return processChunk();
			} );
		}

		return processChunk();
	}

	function extractDescription( wikitext ) {
		// Try |description= from the Information template
		var match = wikitext.match(
			/\|\s*[Dd]escription\s*=\s*([\s\S]*?)(?=\n\s*\||\n\s*\}\})/m
		);
		if ( match ) {
			var desc = match[ 1 ].trim();
			desc = desc.replace( /\{\{[^}]*\}\}/g, '' );
			desc = desc.replace( /\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1' );
			desc = desc.replace( /'''?/g, '' );
			desc = desc.replace( /\s+/g, ' ' ).trim();
			if ( desc ) {
				return desc.substring( 0, 500 );
			}
		}
		// Fallback: first meaningful line
		var lines = wikitext.split( '\n' );
		var i, len, line;
		for ( i = 0, len = lines.length; i < len; i++ ) {
			line = lines[ i ].trim();
			if ( line && !line.match( /^\s*[\[{|!=<]/ ) && line.length > 10 ) {
				return line.substring( 0, 300 );
			}
		}
		return '';
	}

	// -----------------------------------------------------------------------
	// LLM: build prompt, call Worker, parse response
	// -----------------------------------------------------------------------
	function buildLLMPrompt( subcatNames, fileBatch ) {
		var catDisplay = state.categoryTitle.replace( /^Category:/, '' );
		var subcatList = subcatNames.join( '\n' );

		var filesSection = [];
		var i, len, f, name, desc, cats;
		for ( i = 0, len = fileBatch.length; i < len; i++ ) {
			f = fileBatch[ i ];
			name = f.title.replace( /^File:/, '' );
			desc = f.description || '(no description)';
			cats = f.categories.length ? f.categories.join( ', ' ) : '(none)';
			filesSection.push(
				( i + 1 ) + '. Name: ' + name + '\n' +
				'   Description: ' + desc + '\n' +
				'   Current categories: ' + cats
			);
		}

		return 'You are helping categorize Wikimedia Commons files. The category ' +
			'"' + catDisplay + '" needs to be diffused — files should be moved to ' +
			'more specific subcategories.\n\n' +
			'Here are ALL available subcategories (within ' + CONFIG.maxTreeDepth +
			' levels of depth):\n' +
			subcatList + '\n\n' +
			'For each file below, pick 3-5 categories from the above list that ' +
			'best fit the file. Only pick categories from the list above. ' +
			'If none of the listed categories fit well, return an empty list for that file.\n\n' +
			'Output ONLY valid JSON in this exact format (use full filenames with "File:" prefix as keys):\n' +
			'{"File:filename1.jpg": ["Cat1", "Cat2"], "File:filename2.jpg": ["Cat3"]}\n\n' +
			'Files:\n\n' + filesSection.join( '\n\n' );
	}

	function callLLM( prompt ) {
		return $.ajax( {
			url: CONFIG.llmProxyUrl,
			method: 'POST',
			contentType: 'application/json',
			data: JSON.stringify( {
				model: CONFIG.llmModel,
				messages: [ { role: 'user', content: prompt } ],
				max_tokens: CONFIG.llmMaxTokens,
				temperature: CONFIG.llmTemperature
			} ),
			dataType: 'json',
			timeout: 120000
		} ).then( function ( data ) {
			if ( data.choices && data.choices[ 0 ] ) {
				return data.choices[ 0 ].message.content || '';
			}
			return '';
		} );
	}

	function parseLLMResponse( responseText, validCatsSet ) {
		// Extract JSON from response (LLM may include markdown fences)
		var jsonMatch = responseText.match( /\{[\s\S]*\}/ );
		if ( !jsonMatch ) {
			mw.log.warn( 'CategoryDiffusion: no JSON in LLM response' );
			return {};
		}

		var parsed;
		try {
			parsed = JSON.parse( jsonMatch[ 0 ] );
		} catch ( e ) {
			mw.log.warn( 'CategoryDiffusion: failed to parse LLM JSON', e );
			return {};
		}

		var result = {};
		var fileTitle, cats, validated, i, len, cat;

		for ( fileTitle in parsed ) {
			if ( !parsed.hasOwnProperty( fileTitle ) ) {
				continue;
			}
			cats = parsed[ fileTitle ];
			if ( !$.isArray( cats ) ) {
				continue;
			}

			// Normalise file title
			if ( fileTitle.indexOf( 'File:' ) !== 0 ) {
				fileTitle = 'File:' + fileTitle;
			}

			validated = [];
			for ( i = 0, len = cats.length; i < len; i++ ) {
				cat = String( cats[ i ] ).trim();
				if ( validCatsSet[ cat ] ) {
					validated.push( cat );
				}
			}
			result[ fileTitle ] = validated;
		}

		return result;
	}

	// -----------------------------------------------------------------------
	// Wake Lock: prevent browser from freezing the tab during analysis
	// -----------------------------------------------------------------------
	var wakeLockSentinel = null;
	var wakeLockActive = false;

	function acquireWakeLock() {
		wakeLockActive = true;
		requestWakeLock();
		// The Screen Wake Lock is released automatically when the tab becomes
		// hidden. Re-acquire it when the tab becomes visible again so the
		// analysis can keep running if the user switches away a second time.
		document.addEventListener( 'visibilitychange', onVisibilityChange );
	}

	function requestWakeLock() {
		if ( !wakeLockActive || !navigator.wakeLock ) {
			return;
		}
		navigator.wakeLock.request( 'screen' ).then( function ( sentinel ) {
			wakeLockSentinel = sentinel;
		}, function () {
			// Wake Lock denied (e.g. page not visible) – continue without it
		} );
	}

	function onVisibilityChange() {
		if ( document.visibilityState === 'visible' && wakeLockActive ) {
			requestWakeLock();
		}
	}

	function releaseWakeLock() {
		wakeLockActive = false;
		document.removeEventListener( 'visibilitychange', onVisibilityChange );
		if ( wakeLockSentinel ) {
			wakeLockSentinel.release();
			wakeLockSentinel = null;
		}
	}

	// -----------------------------------------------------------------------
	// Analysis pipeline (runs entirely in-browser)
	// -----------------------------------------------------------------------
	function startAnalysis() {
		if ( state.analysisStatus === 'running' ) {
			return;
		}

		// Clear previous results so a re-run starts fresh
		state.suggestions = {};
		state.subcategories = [];
		state.fileMetadata = {};
		state.analysisStatus = 'running';

		// Acquire a Web Lock to prevent the browser from freezing this tab
		// while the analysis is running in the background.
		acquireWakeLock();
		// Now that the analysis has been started explicitly by the user,
		// (re)inject per-thumbnail buttons so they appear only after the
		// script has been run at least once.
		injectThumbnailButtons();
		updateThumbnailButtons();

		// Step 1: Crawl subcategory tree
		updateStatus( 'Crawling subcategory tree…' );

		crawlSubcategoryTree().then( function ( subcatTitles ) {
			if ( subcatTitles.length === 0 ) {
				state.analysisStatus = 'done';
				state.suggestions = {};
				releaseWakeLock();
				updateStatus( 'No subcategories found.' );
				updatePanelProgress( 'No subcategories found.' );
				return;
			}

			// Strip "Category:" prefix for display and LLM prompt
			var subcatNames = [];
			var i, len;
			for ( i = 0, len = subcatTitles.length; i < len; i++ ) {
				subcatNames.push( subcatTitles[ i ].replace( /^Category:/, '' ) );
			}
			state.subcategories = subcatNames;

			updateStatus(
				'Found ' + subcatNames.length + ' subcategories. Fetching files…'
			);

			// Step 2: Fetch files
			return fetchCategoryFiles().then( function ( fileTitles ) {
				if ( fileTitles.length === 0 ) {
					state.analysisStatus = 'done';
					state.suggestions = {};
					saveCachedSuggestions();
					releaseWakeLock();
					updateStatus( 'No files found in category.' );
					updatePanelProgress( 'No files found in category.' );
					return;
				}

				updateStatus(
					'Fetching metadata for ' + fileTitles.length + ' files…'
				);

				// Step 3: Fetch file metadata
				return fetchFileDescriptions( fileTitles ).then( function ( metadata ) {
					state.fileMetadata = metadata;

					// Step 4: Batch LLM calls
					return runLLMBatches( subcatNames, metadata );
				} );
			} );
		} ).fail( function ( err ) {
			state.analysisStatus = 'error';
			releaseWakeLock();
			var errorMsg = 'Error: ' + ( err && err.message || err || 'Analysis failed.' );
			updateStatus( errorMsg );
			updatePanelProgress( errorMsg );
		} );
	}

	function runLLMBatches( subcatNames, metadata ) {
		var fileTitles = Object.keys( metadata );
		var totalBatches = Math.ceil( fileTitles.length / CONFIG.filesPerBatch );
		var batchIdx = 0;
		var allSuggestions = {};

		// Build valid category set for validation
		var validCatsSet = {};
		var i, len;
		for ( i = 0, len = subcatNames.length; i < len; i++ ) {
			validCatsSet[ subcatNames[ i ] ] = true;
		}

		function processBatch() {
			if ( batchIdx >= totalBatches ) {
				// All batches done
				state.suggestions = allSuggestions;

				// Ensure every file has an entry
				for ( i = 0, len = fileTitles.length; i < len; i++ ) {
					if ( !allSuggestions[ fileTitles[ i ] ] ) {
						allSuggestions[ fileTitles[ i ] ] = [];
					}
				}

				state.analysisStatus = 'done';
				saveCachedSuggestions();
				releaseWakeLock();
				updateThumbnailButtons();
				updatePanelProgress();
				return $.Deferred().resolve().promise();
			}

			var start = batchIdx * CONFIG.filesPerBatch;
			var end = Math.min( start + CONFIG.filesPerBatch, fileTitles.length );
			var batchTitles = fileTitles.slice( start, end );
			batchIdx++;

			updateStatus(
				'LLM batch ' + batchIdx + '/' + totalBatches +
				' (' + batchTitles.length + ' files)…'
			);

			// Build batch for prompt
			var fileBatch = [];
			var j, title, meta;
			for ( j = 0; j < batchTitles.length; j++ ) {
				title = batchTitles[ j ];
				meta = metadata[ title ] || {};
				fileBatch.push( {
					title: title,
					description: meta.description || '',
					categories: meta.categories || []
				} );
			}

			var prompt = buildLLMPrompt( subcatNames, fileBatch );

			return callLLM( prompt ).then( function ( responseText ) {
				var batchResult = parseLLMResponse( responseText, validCatsSet );
				$.extend( allSuggestions, batchResult );
				return processBatch();
			}, function ( err ) {
				mw.log.warn( 'CategoryDiffusion: LLM batch failed', err );
				// Continue with next batch
				return processBatch();
			} );
		}

		return processBatch();
	}

	// -----------------------------------------------------------------------
	// UI: Analyse button
	// -----------------------------------------------------------------------
	function createToolsLink() {
		var portletLink = mw.util.addPortletLink(
			'p-tb',
			'#',
			'Diffusor',
			't-catdiffusion',
			'Analyse this category with Diffusor'
		);
		if ( portletLink ) {
			$( portletLink ).on( 'click.catdiffusion', function ( e ) {
				e.preventDefault();
				openAnalysisPanel();
				startAnalysis();
			} );
		}
	}

	function updateStatus( text ) {
		updatePanelProgress( text );
	}

	function updatePanelProgress( currentStatus ) {
		var $status = $( '#catdiff-progress-status' );
		var $stages = $( '#catdiff-progress-stages' );
		
		if ( !currentStatus ) {
			currentStatus = '';
		}

		var stages = [];
		var currentStage = 'idle';

		if ( state.analysisStatus === 'running' ) {
			// Determine which stage we're in based on status text
			if ( currentStatus.indexOf( 'Crawling' ) >= 0 || currentStatus.indexOf( 'Depth' ) >= 0 ) {
				currentStage = 'crawling';
				stages.push( { name: 'Crawling subcategory tree', status: 'active', detail: currentStatus } );
				stages.push( { name: 'Fetching files', status: 'pending' } );
				stages.push( { name: 'Fetching file metadata', status: 'pending' } );
				stages.push( { name: 'Analyzing with LLM', status: 'pending' } );
			} else if ( currentStatus.indexOf( 'Fetching files' ) >= 0 || currentStatus.indexOf( 'Found' ) >= 0 && currentStatus.indexOf( 'subcategories' ) >= 0 ) {
				currentStage = 'fetching-files';
				stages.push( { name: 'Crawling subcategory tree', status: 'done' } );
				stages.push( { name: 'Fetching files', status: 'active', detail: currentStatus } );
				stages.push( { name: 'Fetching file metadata', status: 'pending' } );
				stages.push( { name: 'Analyzing with LLM', status: 'pending' } );
			} else if ( currentStatus.indexOf( 'Fetching metadata' ) >= 0 || currentStatus.indexOf( 'batch' ) >= 0 && currentStatus.indexOf( 'metadata' ) >= 0 ) {
				currentStage = 'fetching-metadata';
				stages.push( { name: 'Crawling subcategory tree', status: 'done' } );
				stages.push( { name: 'Fetching files', status: 'done' } );
				stages.push( { name: 'Fetching file metadata', status: 'active', detail: currentStatus } );
				stages.push( { name: 'Analyzing with LLM', status: 'pending' } );
			} else if ( currentStatus.indexOf( 'LLM' ) >= 0 || currentStatus.indexOf( 'batch' ) >= 0 ) {
				currentStage = 'llm';
				stages.push( { name: 'Crawling subcategory tree', status: 'done' } );
				stages.push( { name: 'Fetching files', status: 'done' } );
				stages.push( { name: 'Fetching file metadata', status: 'done' } );
				stages.push( { name: 'Analyzing with LLM', status: 'active', detail: currentStatus } );
			} else {
				// Fallback: show all stages with current status
				stages.push( { name: 'Crawling subcategory tree', status: 'pending' } );
				stages.push( { name: 'Fetching files', status: 'pending' } );
				stages.push( { name: 'Fetching file metadata', status: 'pending' } );
				stages.push( { name: 'Analyzing with LLM', status: 'pending' } );
			}
		} else if ( state.analysisStatus === 'done' ) {
			var fileCount = Object.keys( state.suggestions ).length;
			var withSuggestions = 0;
			var key;
			for ( key in state.suggestions ) {
				if ( state.suggestions.hasOwnProperty( key ) &&
					state.suggestions[ key ].length > 0 ) {
					withSuggestions++;
				}
			}
			
			stages.push( { name: 'Crawling subcategory tree', status: 'done' } );
			stages.push( { name: 'Fetching files', status: 'done' } );
			stages.push( { name: 'Fetching file metadata', status: 'done' } );
			stages.push( { name: 'Analyzing with LLM', status: 'done' } );
			
			if ( withSuggestions > 0 ) {
				$status.html(
					'<strong style="color: #14866d;">✓ Analysis complete!</strong><br>' +
					withSuggestions + ' of ' + fileCount + ' files have suggestions.<br>' +
					'Look for the green <b>View suggestions</b> buttons below each thumbnail.'
				);
			} else {
				$status.html(
					'<strong>Analysis complete.</strong><br>' +
					'No suggestions were generated for any file.'
				);
			}
		} else if ( state.analysisStatus === 'error' ) {
			$status.html( '<strong style="color: #d33;">Error:</strong> ' + ( currentStatus || 'Analysis failed.' ) );
			stages.push( { name: 'Crawling subcategory tree', status: 'error' } );
		} else {
			$status.text( currentStatus || 'Ready to start analysis.' );
		}

		// Render stages
		if ( stages.length > 0 ) {
			var html = '<ul style="list-style: none; padding: 0; margin: 12px 0;">';
			var i, len, stage, icon, color;
			for ( i = 0, len = stages.length; i < len; i++ ) {
				stage = stages[ i ];
				if ( stage.status === 'done' ) {
					icon = '✓';
					color = '#14866d';
				} else if ( stage.status === 'active' ) {
					icon = '⟳';
					color = '#36c';
				} else if ( stage.status === 'error' ) {
					icon = '✗';
					color = '#d33';
				} else {
					icon = '○';
					color = '#999';
				}
				html += '<li style="padding: 4px 0; color: ' + color + ';">';
				html += '<span style="font-weight: bold; margin-right: 6px;">' + icon + '</span>';
				html += stage.name;
				if ( stage.detail ) {
					html += ' <span style="font-size: 11px; color: #72777d;">(' + stage.detail + ')</span>';
				}
				html += '</li>';
			}
			html += '</ul>';
			$stages.html( html );
		} else {
			$stages.empty();
		}
	}

	// -----------------------------------------------------------------------
	// UI: Per-thumbnail suggest buttons
	// -----------------------------------------------------------------------
	function injectThumbnailButtons() {
		// Hide per-thumbnail buttons until the script has actually been run
		// (or cached results are available). This avoids showing disabled
		// "View suggestions" buttons on first page load before analysis.
		if ( state.analysisStatus === 'idle' &&
			!Object.keys( state.suggestions ).length ) {
			return;
		}

		var $galleryItems = $( '.gallerybox' );
		var i, len, $item, $link, fileTitle, $btn;

		for ( i = 0, len = $galleryItems.length; i < len; i++ ) {
			$item = $galleryItems.eq( i );
			$link = $item.find( 'a.image, .thumb a' ).first();
			if ( !$link.length ) {
				continue;
			}

			fileTitle = extractFileTitleFromLink( $link );
			if ( !fileTitle ) {
				continue;
			}

			if ( $item.find( '.catdiff-suggest-btn' ).length ) {
				continue;
			}

			$btn = $( '<button>' )
				.addClass( 'catdiff-suggest-btn' )
				.attr( 'data-file', fileTitle )
				.text( 'View suggestions' )
				.prop( 'disabled', state.analysisStatus !== 'done' ||
					!( state.suggestions[ fileTitle ] &&
						state.suggestions[ fileTitle ].length ) );

			if ( state.reviewedFiles[ fileTitle ] ) {
				$btn.addClass( 'catdiff-reviewed' );
				$item.addClass( 'catdiff-gallery-reviewed' );
			}

			if ( state.suggestions[ fileTitle ] &&
				state.suggestions[ fileTitle ].length ) {
				$btn.addClass( 'catdiff-has-suggestions' );
			}

			$btn.on( 'click.catdiffusion', function ( e ) {
				e.preventDefault();
				e.stopPropagation();
				openPanel( $( this ).attr( 'data-file' ) );
			} );

			var $caption = $item.find( '.gallerytext' );
			if ( $caption.length ) {
				$caption.append( $btn );
			} else {
				$item.append( $btn );
			}
		}
	}

	function extractFileTitleFromLink( $link ) {
		var href = $link.attr( 'href' );
		if ( !href ) {
			return null;
		}
		var match = href.match( /\/wiki\/(File:[^?#]+)/ );
		if ( match ) {
			return decodeURIComponent( match[ 1 ].replace( /_/g, ' ' ) );
		}
		match = href.match( /title=(File:[^&#]+)/ );
		if ( match ) {
			return decodeURIComponent( match[ 1 ].replace( /_/g, ' ' ) );
		}
		return null;
	}

	function updateThumbnailButtons() {
		var $buttons = $( '.catdiff-suggest-btn' );
		var isReady = state.analysisStatus === 'done';
		var i, len, $btn, fileTitle, hasSuggestions;

		for ( i = 0, len = $buttons.length; i < len; i++ ) {
			$btn = $buttons.eq( i );
			fileTitle = $btn.attr( 'data-file' );
			hasSuggestions = state.suggestions[ fileTitle ] &&
				state.suggestions[ fileTitle ].length;

			// Disable if analysis not done OR no suggestions for this file
			$btn.prop( 'disabled', !isReady || !hasSuggestions );

			if ( state.reviewedFiles[ fileTitle ] ) {
				$btn.addClass( 'catdiff-reviewed' );
				$btn.closest( '.gallerybox' ).addClass( 'catdiff-gallery-reviewed' );
			}
			if ( hasSuggestions ) {
				$btn.addClass( 'catdiff-has-suggestions' );
			}
		}
	}

	// -----------------------------------------------------------------------
	// UI: Right-side panel
	// -----------------------------------------------------------------------
	function createPanel() {
		var html = [
			'<div id="catdiff-panel">',
			'  <button id="catdiff-panel-close" title="Close panel">&times;</button>',
			'  <h3 id="catdiff-panel-title">Diffusor</h3>',
			'  <div id="catdiff-panel-analysis-view">',
			'    <div class="catdiff-section">',
			'      <div class="catdiff-section-title">Analysis progress</div>',
			'      <div id="catdiff-progress-status">Ready to start analysis.</div>',
			'      <div id="catdiff-progress-stages"></div>',
			'    </div>',
			'  </div>',
			'  <div id="catdiff-panel-file-view" style="display: none;">',
			'    <img id="catdiff-panel-thumb" src="" alt="" />',
			'    <div class="catdiff-section">',
			'      <div class="catdiff-section-title">Description</div>',
			'      <div id="catdiff-description"></div>',
			'    </div>',
			'    <div class="catdiff-section">',
			'      <div class="catdiff-section-title">Current categories</div>',
			'      <ul id="catdiff-current-cats"></ul>',
			'    </div>',
			'    <div class="catdiff-section">',
			'      <div class="catdiff-section-title">Suggested categories</div>',
			'      <ul id="catdiff-suggestions-list"></ul>',
			'      <div id="catdiff-suggestion-count"></div>',
			'    </div>',
			'    <div class="catdiff-actions">',
			'      <button class="catdiff-btn-accept">Accept</button>',
			'      <button class="catdiff-btn-reject">Reject</button>',
			'    </div>',
			'  </div>',
			'</div>'
		].join( '\n' );

		$( 'body' ).append( html );

		$( '#catdiff-panel-close' ).on( 'click.catdiffusion', function ( e ) {
			e.preventDefault();
			closePanel();
		} );

		$( '.catdiff-btn-accept' ).on( 'click.catdiffusion', function ( e ) {
			e.preventDefault();
			acceptSuggestions();
		} );

		$( '.catdiff-btn-reject' ).on( 'click.catdiffusion', function ( e ) {
			e.preventDefault();
			rejectSuggestions();
		} );
	}

	function openAnalysisPanel() {
		var $panel = $( '#catdiff-panel' );
		$( '#catdiff-panel-title' ).text( 'Diffusor — ' + state.categoryTitle.replace( /^Category:/, '' ) );
		$( '#catdiff-panel-analysis-view' ).show();
		$( '#catdiff-panel-file-view' ).hide();
		$panel.addClass( 'catdiff-panel-open' );
		$( 'body' ).addClass( 'catdiff-panel-active' );
		updatePanelProgress();
	}

	function openPanel( fileTitle ) {
		state.currentFile = fileTitle;
		var $panel = $( '#catdiff-panel' );

		// Set title
		$( '#catdiff-panel-title' ).text( fileTitle.replace( /^File:/, '' ) );
		$( '#catdiff-panel-analysis-view' ).hide();
		$( '#catdiff-panel-file-view' ).show();
		$( '#catdiff-panel-thumb' ).attr( 'src', '' ).hide();
		$( '#catdiff-description' ).text( 'Loading…' );
		$( '#catdiff-current-cats' ).empty().append( '<li>Loading…</li>' );
		$( '#catdiff-suggestions-list' ).empty();
		$( '#catdiff-suggestion-count' ).text( '' );

		$panel.addClass( 'catdiff-panel-open' );
		$( 'body' ).addClass( 'catdiff-panel-active' );

		// Use cached metadata if available, otherwise fetch
		if ( state.fileMetadata[ fileTitle ] ) {
			populatePanelFromCache( fileTitle );
		}

		// Always fetch thumbnail (not cached in metadata)
		fetchThumbnail( fileTitle );
	}

	function closePanel() {
		state.currentFile = null;
		$( '#catdiff-panel' ).removeClass( 'catdiff-panel-open' );
		$( 'body' ).removeClass( 'catdiff-panel-active' );
	}

	function fetchThumbnail( fileTitle ) {
		var api = new mw.Api();
		api.get( {
			action: 'query',
			titles: fileTitle,
			prop: 'imageinfo',
			iiprop: 'url',
			iiurlwidth: 380,
			format: 'json'
		} ).then( function ( data ) {
			if ( state.currentFile !== fileTitle ) {
				return;
			}
			var pages = data.query.pages;
			var pageId = Object.keys( pages )[ 0 ];
			var page = pages[ pageId ];
			if ( page.imageinfo && page.imageinfo[ 0 ] ) {
				var url = page.imageinfo[ 0 ].thumburl || page.imageinfo[ 0 ].url;
				$( '#catdiff-panel-thumb' ).attr( 'src', url ).show();
			}
		} );
	}

	function populatePanelFromCache( fileTitle ) {
		var meta = state.fileMetadata[ fileTitle ] || {};

		// Description
		$( '#catdiff-description' ).text( meta.description || '(no description)' );

		// Current categories
		var currentCats = meta.categories || [];
		var $catList = $( '#catdiff-current-cats' ).empty();
		if ( currentCats.length === 0 ) {
			$catList.append( '<li>None</li>' );
		} else {
			var i, len;
			for ( i = 0, len = currentCats.length; i < len; i++ ) {
				$catList.append( $( '<li>' ).text( currentCats[ i ] ) );
			}
		}

		// Suggested categories
		var suggestions = state.suggestions[ fileTitle ] || [];
		renderSuggestions( suggestions, currentCats );
	}

	// -----------------------------------------------------------------------
	// UI: Suggestions rendering
	// -----------------------------------------------------------------------
	function renderSuggestions( suggestions, currentCats ) {
		var $list = $( '#catdiff-suggestions-list' ).empty();
		var $count = $( '#catdiff-suggestion-count' );

		if ( !suggestions || suggestions.length === 0 ) {
			$list.append( '<li>No suggestions available.</li>' );
			$count.text( '' );
			return;
		}

		var currentCatsSet = {};
		var i, len;
		for ( i = 0, len = currentCats.length; i < len; i++ ) {
			currentCatsSet[ currentCats[ i ] ] = true;
		}

		var newCount = 0;
		var alreadyCount = 0;

		for ( i = 0, len = suggestions.length; i < len; i++ ) {
			var catName = suggestions[ i ];
			var isPresent = !!currentCatsSet[ catName ];
			var $li = $( '<li>' );
			var $label = $( '<label>' );
			var $checkbox = $( '<input>' )
				.attr( 'type', 'checkbox' )
				.attr( 'data-cat', catName );

			if ( isPresent ) {
				$checkbox.prop( 'disabled', true ).prop( 'checked', false );
				$label.addClass( 'catdiff-already-present' );
				alreadyCount++;
			} else {
				$checkbox.prop( 'checked', true );
				newCount++;
			}

			var catUrl = mw.util.getUrl( 'Category:' + catName );
			var $link = $( '<a>' )
				.attr( 'href', catUrl )
				.attr( 'target', '_blank' )
				.text( catName );
			$label.append( $checkbox, ' ', $link );
			$li.append( $label );
			$list.append( $li );
		}

		$count.text(
			suggestions.length + ' suggested, ' +
			alreadyCount + ' already present, ' +
			newCount + ' new'
		);

		// Update Accept button label based on whether there are new categories
		var acceptLabel = newCount > 0
			? 'Accept'
			: 'Remove parent category';
		$( '.catdiff-btn-accept' ).text( acceptLabel );
	}

	function getSelectedCategories() {
		var selected = [];
		$( '#catdiff-suggestions-list input[type="checkbox"]:checked:not(:disabled)' )
			.each( function () {
				selected.push( $( this ).attr( 'data-cat' ) );
			} );
		return selected;
	}

	// -----------------------------------------------------------------------
	// Actions: Accept / Reject
	// -----------------------------------------------------------------------
	function acceptSuggestions() {
		var fileTitle = state.currentFile;
		if ( !fileTitle ) {
			return;
		}

		var selectedCats = getSelectedCategories();

		var api = new mw.Api();

		api.get( {
			action: 'query',
			titles: fileTitle,
			prop: 'revisions',
			rvprop: 'content',
			rvslots: 'main',
			format: 'json'
		} ).then( function ( data ) {
			var pages = data.query.pages;
			var pageId = Object.keys( pages )[ 0 ];
			var page = pages[ pageId ];
			var wikitext = '';

			if ( page.revisions && page.revisions[ 0 ] ) {
				var rev = page.revisions[ 0 ];
				if ( rev.slots && rev.slots.main ) {
					wikitext = rev.slots.main[ '*' ] || rev.slots.main.content || '';
				} else if ( rev[ '*' ] ) {
					wikitext = rev[ '*' ];
				}
			}

			// Remove the parent category being diffused and remember where it was
			var parentCat = state.categoryTitle.replace( /^Category:/, '' );
			// Normalise underscores to spaces (wgPageName uses underscores, wikitext uses spaces)
			parentCat = parentCat.replace( /_/g, ' ' );
			// Escape regex special characters
			var escapedCat = parentCat.replace( /[-.*+?^${}()|\\[\]\/]/g, '\\$&' );
			// Allow both underscores and spaces to match interchangeably
			escapedCat = escapedCat.replace( / /g, '[_ ]' );
			// Make first char case-insensitive (MediaWiki normalises this)
			var firstChar = escapedCat.charAt( 0 );
			if ( firstChar !== '[' ) {
				escapedCat = '[' + firstChar.toUpperCase() + firstChar.toLowerCase() + ']' +
					escapedCat.slice( 1 );
			}
			var catRegex = new RegExp(
				'\\n?\\s*\\[\\[\\s*[Cc]ategory\\s*:\\s*' + escapedCat +
				'(?:\\s*\\|[^\\]]*)?\\s*\\]\\]', 'g'
			);

			// Find all occurrences so we can both remove them and know where
			// in the wikitext to insert the new categories.
			var match;
			var firstMatchStart = null;
			var lastMatchEnd = null;

			while ( ( match = catRegex.exec( wikitext ) ) ) {
				if ( firstMatchStart === null ) {
					firstMatchStart = match.index;
				}
				lastMatchEnd = match.index + match[ 0 ].length;
			}

			if ( firstMatchStart === null ) {
				// Parent category not found – fall back to appending at the end
				var i, len;
				for ( i = 0, len = selectedCats.length; i < len; i++ ) {
					wikitext += '\n[[Category:' + selectedCats[ i ] + ']]';
				}
			} else {
				// Remove all occurrences of the parent category and insert the
				// new categories where the parent used to be.
				var before = wikitext.slice( 0, firstMatchStart );
				var after = wikitext.slice( lastMatchEnd );
				var insertion = '';
				var i, len;

				for ( i = 0, len = selectedCats.length; i < len; i++ ) {
					insertion += '\n[[Category:' + selectedCats[ i ] + ']]';
				}

				wikitext = before + insertion + after;
			}

			// Build a descriptive edit summary
			var summaryParts = [];
			if ( parentCat ) {
				summaryParts.push( 'removed [[Category:' + parentCat + ']]' );
			}
			if ( selectedCats.length ) {
				var addedCats = [];
				var i, len;
				for ( i = 0, len = selectedCats.length; i < len; i++ ) {
					addedCats.push( '[[Category:' + selectedCats[ i ] + ']]' );
				}
				summaryParts.push( 'added ' + addedCats.join( ', ' ) );
			}
			var humanSummary;
			if ( summaryParts.length ) {
				humanSummary = 'Diffusor: ' + summaryParts.join( '; ' );
			} else {
				humanSummary = 'Diffusor: removed parent category';
			}
			var fullSummary = humanSummary + ' ([[User:Alaexis/Diffusor.js|Diffusor]])';

			// Store for edit-page prefill
			var storageKey = CONFIG.localStoragePrefix + 'prefill-' +
				fileTitle.replace( / /g, '_' );
			try {
				sessionStorage.setItem( storageKey, wikitext );
			} catch ( e ) {
				// sessionStorage unavailable
			}

			markAsReviewed( fileTitle );

			// Either save via API (with optional tag) or open the edit form
			// prefilled, depending on configuration.
			if ( CONFIG.useApiEdit ) {
				var editParams = {
					action: 'edit',
					title: fileTitle,
					text: wikitext,
					summary: fullSummary
				};
				api.postWithEditToken( editParams ).then( function () {
					// Optionally, we could show a small confirmation, but for
					// now just leave it silent.
				}, function ( err ) {
					mw.log.warn( 'CategoryDiffusion: API edit failed', err );
				} );
			} else {
				var editUrl = mw.util.getUrl( fileTitle, {
					action: 'edit',
					summary: fullSummary
				} );
				window.open( editUrl, '_blank' );
			}
		} );
	}

	function rejectSuggestions() {
		var fileTitle = state.currentFile;
		if ( !fileTitle ) {
			return;
		}
		markAsReviewed( fileTitle );
		
		// Move to the next unreviewed file with suggestions so users can
		// quickly step through items on the page without the panel closing.
		var $buttons = $( '.catdiff-suggest-btn' );
		var i, len, idx = -1;

		for ( i = 0, len = $buttons.length; i < len; i++ ) {
			if ( $buttons.eq( i ).attr( 'data-file' ) === fileTitle ) {
				idx = i;
				break;
			}
		}

		if ( idx === -1 ) {
			closePanel();
			return;
		}

		function openNextFrom( startIdx ) {
			var j, jLen, $btn, nextTitle;
			for ( j = startIdx, jLen = $buttons.length; j < jLen; j++ ) {
				$btn = $buttons.eq( j );
				nextTitle = $btn.attr( 'data-file' );
				if ( !nextTitle ) {
					continue;
				}
				if ( state.reviewedFiles[ nextTitle ] ) {
					continue;
				}
				if ( !( state.suggestions[ nextTitle ] &&
					state.suggestions[ nextTitle ].length ) ) {
					continue;
				}
				openPanel( nextTitle );
				return true;
			}
			return false;
		}

		// Try to move forward; if we reach the end, wrap around to the start.
		if ( !openNextFrom( idx + 1 ) && !openNextFrom( 0 ) ) {
			// No more suitable items – close the panel.
			closePanel();
		}
	}

	function markAsReviewed( fileTitle ) {
		state.reviewedFiles[ fileTitle ] = true;
		saveReviewedState();

		var $btn = $( '.catdiff-suggest-btn[data-file="' +
			$.escapeSelector( fileTitle ) + '"]' );
		$btn.addClass( 'catdiff-reviewed' );
		$btn.closest( '.gallerybox' ).addClass( 'catdiff-gallery-reviewed' );
	}

	// -----------------------------------------------------------------------
	// Edit page: prefill wikitext from sessionStorage
	// -----------------------------------------------------------------------
	function checkEditPagePrefill() {
		if ( mw.config.get( 'wgAction' ) !== 'edit' &&
			mw.config.get( 'wgAction' ) !== 'submit' ) {
			return;
		}

		var pageTitle = mw.config.get( 'wgPageName' ).replace( /_/g, ' ' );
		var storageKey = CONFIG.localStoragePrefix + 'prefill-' +
			pageTitle.replace( / /g, '_' );

		var prefillContent;
		try {
			prefillContent = sessionStorage.getItem( storageKey );
		} catch ( e ) {
			return;
		}
		if ( !prefillContent ) {
			return;
		}

		try {
			sessionStorage.removeItem( storageKey );
		} catch ( e ) {
			// ignore
		}

		$( function () {
			var $textarea = $( '#wpTextbox1' );
			if ( $textarea.length ) {
				$textarea.val( prefillContent );
				if ( $textarea[ 0 ] &&
					typeof $textarea[ 0 ].scrollTop !== 'undefined' ) {
					$textarea[ 0 ].scrollTop = $textarea[ 0 ].scrollHeight;
				}
			}
		} );
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------
	function init() {
		injectStyles();
		loadReviewedState();

		var hasCached = loadCachedSuggestions();

		createToolsLink();
		createPanel();
		injectThumbnailButtons();

		if ( hasCached ) {
			updateThumbnailButtons();
		}
	}

	// -----------------------------------------------------------------------
	// Entry point
	// -----------------------------------------------------------------------

	// Edit-page prefill runs on ALL pages (including edit tabs)
	checkEditPagePrefill();

	// Main UI only on category pages
	if ( mw.config.get( 'wgNamespaceNumber' ) !== 14 ) {
		return;
	}

	mw.loader.using(
		[ 'mediawiki.api', 'mediawiki.util' ],
		init
	);

}() );
