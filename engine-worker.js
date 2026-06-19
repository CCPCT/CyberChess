// engine-worker.js

const nativeFetch = self.fetch;

// 2. MONKEY PATCH FETCH SYNCHRONOUSLY BEFORE ANYTHING ELSE RUNS
self.fetch = function(url, options) {
    const urlString = String(url);
    if (urlString.endsWith('.wasm') || urlString.includes('.wasm?')) {
        console.log("🎯 Network Interceptor redirecting internal engine fetch to: ./stockfish-18-lite-single.wasm");
        return nativeFetch('./stockfish-18-lite-single.wasm', options);
    }
    return nativeFetch(url, options);
};

// 3. Core global engine intercept module configuration
var Module = {
    print: function(line) {
        self.postMessage(line);
    },
    printErr: function(line) {
        console.warn("Stockfish Engine Internal Warning:", line);
    },
    onRuntimeInitialized: function() {
        console.log("🚀 Stockfish Emscripten runtime fully ready!");
        // Emscripten handles its own boot confirmation, but we can verify here
    }
};

importScripts('stockfish-18-lite-single.js');
