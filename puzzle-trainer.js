const boardElement = document.getElementById('board');
const piecesLayer = document.getElementById('pieces-layer');
const historyContainer = document.getElementById('history-container');

let debug = false;

// Evaluation queue
let engineBusy = false;
let evalPending = false;

let oldEval = 0;

// Latest requested position
let pendingFen = null;

// Used to ignore results after a crash/restart
let engineGeneration = 0;

let puzzleStartFen = "";
let puzzleStartHistoryLength = 0;
let game = new Chess(); 
let initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
let selectedSquare = null;
let legalMovesForSelected = [];
let pendingSearchSync = false;

let boardFlipped = false; 
let lastMoveSquares = [];
let squareBadge = null; 

let whitePlayerName = "Unknown White";
let blackPlayerName = "Unknown Black";

// History State Engine
let historyState = []; 
let currentHistoryIndex = -1; 

// Engine Control States
let engineWorker = null;
let isEngineReady = false;
let engineMode = "IDLE"; 
let engineWatchdog = null;

// Engine Configuration Options
const ENGINE_CONFIG = {
    threads: 1,      // Number of CPU cores to assign Stockfish WASM
    hashMemory: 32  // Memory cache size in MB
};

// Engine Evaluation Tracking
let currentEval = 0; 
let currentMultiPvData = {};
let pendingBadgeSquare = null;
let candidateGameFen = "";
let candidateHistory = [];
let candidateGameData = null;
let puzzleSearchAttempts = 0;
const MAX_SEARCH_ATTEMPTS = 100;

const SOUNDS = {
    move: new Audio('./assets/sounds/move.mp3'),
    capture: new Audio('./assets/sounds/capture.mp3'),
    check: new Audio('./assets/sounds/check.mp3'),
    promote: new Audio('./assets/sounds/promote.mp3'),
    castle: new Audio('./assets/sounds/castle.mp3')
};

function playSound(type) {
    if (SOUNDS[type]) {
        SOUNDS[type].currentTime = 0; // Rewind to start for rapid playback
        SOUNDS[type].play().catch(e => console.log("Audio play blocked by browser."));
    }
}

function playMoveSound(moveObj) {
    if (game.in_check()) {
        playSound('check');
    } else if (moveObj.promotion) {
        playSound('promote');
    } else if (moveObj.flags.includes('k') || moveObj.flags.includes('q')) {
        playSound('castle');
    } else if (moveObj.flags.includes('c') || moveObj.flags.includes('e')) {
        playSound('capture');
    } else {
        playSound('move');
    }
}

let isScrolling = false;

boardElement.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (isScrolling) return;

    isScrolling = true;
    
    if (event.deltaY < 0) {
        if (currentHistoryIndex > 0) jumpToHistoryMove(currentHistoryIndex - 1);
    } else if (event.deltaY > 0) {
        if (currentHistoryIndex < historyState.length - 1) jumpToHistoryMove(currentHistoryIndex + 1);
    }

    // Reset scroll lock after 300ms (adjust speed as needed)
    setTimeout(() => { isScrolling = false; }, 67);
}, { passive: false });

let maxEngineDepth = 16

document.addEventListener("DOMContentLoaded", () => {
    const slider = document.getElementById("depth-slider");
    const display = document.getElementById("depth-value");

    if (slider && display) {
        // Sync initial state
        maxEngineDepth = parseInt(slider.value);
        display.textContent = maxEngineDepth;

        // Update value continuously as the user drags the slider
        slider.addEventListener("input", (e) => {
            maxEngineDepth = parseInt(e.target.value);
            display.textContent = maxEngineDepth;
        });
    }
});

function unlockAudio() {
    Object.values(SOUNDS).forEach(audio => {
        audio.play().then(() => {
            audio.pause();
            audio.currentTime = 0;
        }).catch(() => {});
    });
    document.removeEventListener('click', unlockAudio);
}
document.addEventListener('click', unlockAudio);

function processEvaluationQueue() {

    if (!isEngineReady) return;
    if (engineBusy) return;
    if (!evalPending) return;

    evalPending = false;
    engineBusy = true;

    currentMultiPvData = {};

    engineMode = "RECALCULATING_EVAL";

    engineWorker.postMessage(`position fen ${pendingFen}`);
    engineWorker.postMessage(`go depth ${maxEngineDepth}`);
}

function getKingSquare(color) {
    const board = game.board(); // Returns an 8x8 array
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'];

    for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
            const piece = board[r][f];
            if (piece && piece.type === 'k' && piece.color === color) {
                return files[f] + ranks[r]; // Returns square string like "e1" or "e8"
            }
        }
    }
    return null;
}

function checkGameEndFeedback() {
    let kingSquare = null;
    let icon = null;
    let badgeType = "";

    if (game.in_checkmate()) {
        // The king whose turn it CURRENTLY is has been checkmated
        console.log("detected mate")
        let losingColor = game.turn(); 
        kingSquare = getKingSquare(losingColor);
        icon = accuracyIcons["Checkmate"]; // Or your custom image asset path/Unicode string
        badgeType = "checkmate";
    } 
    else if (game.in_draw() || game.in_stalemate() || game.insufficient_material() || game.in_threefold_repetition()) {
        console.log("detected draw")
        let playerWhoJustMoved = (game.turn() === 'b') ? 'w' : 'b';
        kingSquare = getKingSquare(playerWhoJustMoved);
        icon = accuracyIcons["Draw"]; // Draw icon representation
        badgeType = "draw";
    } else {
        return;
    }

    // If an endgame condition was met, save it to history so it stays when browsing
    if (kingSquare && icon) {
        squareBadge = { square: kingSquare, icon: icon, type: badgeType };
        if (historyState[currentHistoryIndex]) {
            historyState[currentHistoryIndex].badge = squareBadge;
        }
    }
    // drawBoard();
    // updateEvalBar();
}

let mate=0;

function initEngine() {
    unlockAudio()
    engineGeneration++;
    const myGeneration = engineGeneration;

    isEngineReady = false;

    engineWorker = new Worker('engine-worker.js');

    engineWorker.onerror = function(error) {

        console.error("🚨 Engine crashed:", error);

        isEngineReady = false;
        engineBusy = false;
        evalPending = false;

        try {
            engineWorker.terminate();
        } catch {}

        console.warn("Restarting Stockfish...");

        setTimeout(initEngine, 200);
    };

    engineWorker.onmessage = function(event) {
        if (myGeneration !== engineGeneration)
            return;
        const line = event.data;

        if (debug) console.log("🤖 [ENGINE STDOUT]:", line);

        //checkGameEndFeedback();
        
        // Handshake and tuning execution
        if (line === "readyok" || line === "uciok" || line.startsWith("Stockfish")) {
            if (!isEngineReady) {
                isEngineReady = true;
                console.log(`🏆 WebAssembly Chess Engine Loaded Successfully!`);
                console.log(`⚙️ Tuning Engine Performance: Hash: ${ENGINE_CONFIG.hashMemory}MB`);
                
                // Configure engine allocations
                engineWorker.postMessage(`setoption name Hash value ${ENGINE_CONFIG.hashMemory}`);
                engineWorker.postMessage('isready');
                processEvaluationQueue();

            } else if (engineMode === "SEARCHING_PUZZLE" && pendingSearchSync) {
                // Handle sync sequence for puzzle queries
                pendingSearchSync = false;
                engineWorker.postMessage('go depth 10');
            }
        }

        // Parse Evaluation Scores
        // Parse Evaluation Scores
        if (line.startsWith('info depth')) {
            const matchCp = line.match(/score cp (-?\d+)/);
            const matchMate = line.match(/score mate (-?\d+)/);
            const matchPv = line.match(/multipv (\d+)/);

            let score = 0;
            let mateCount = null; // 🔥 Track the exact mate steps

            if (matchCp) {
                score = parseInt(matchCp[1]);
                if (game.turn() === 'b') {
                    score = -score;
                }
            }

            if (debug) console.log("score: "+score);

            let pvIndex = matchPv ? parseInt(matchPv[1]) : 1;
            currentMultiPvData[pvIndex] = score;
            currentEval = score;
            
            if (matchMate) {
                let m = parseInt(matchMate[1]);
                if (game.turn()==='b') {
                    mate = m
                } else {
                    mate = -m;
                }
                currentEval=mate/Math.abs(mate)*100000
                if (debug) console.log("mate: "+mate);
            } else {
                mate = 0;
            }
            
            // 🔥 Pass both the score and the mate count to your UI updater
            updateEvalBar();
            
        }

        // Action Dispatcher on Engine Completion
        if (line.startsWith('bestmove')) {
            clearTimeout(engineWatchdog); // Reset watchdog on successful processing loop

            const parts = line.split(' ');
            const engineBestMove = parts[1]; 

            if (engineMode === "SEARCHING_PUZZLE") {
                let score = currentMultiPvData[1] || 0;
                const pName = `${candidateGameData.white || "Unknown"} vs ${candidateGameData.black || "Unknown"}`;
                
                if (Math.abs(score) <= 100) {
                    console.log(`✅ [SUCCESS] Found balanced position! Eval: ${(score / 100).toFixed(2)}. Loading puzzle.`);
                    setupPuzzleBoard(candidateGameData, candidateHistory, candidateGameFen, score);
                } else {
                    console.log(`❌ [FAILED] ${pName} -> Eval was ${(score / 100).toFixed(2)} (Outside ±1.0 range).`);
                    currentMultiPvData = {}; 
                    setTimeout(searchNextCandidate, 10);
                }

                engineBusy = false;
                processEvaluationQueue();
            } 
            else if (engineMode === "EVALUATING_USER") {

                let userSquare = pendingBadgeSquare;
                pendingBadgeSquare = null; 
                let bestScore = currentMultiPvData[1] || 0;
                let evalDiff = Math.abs(oldEval - currentEval);

                if (evalDiff>9000 || (game.turn() === "b" ? mate<=0 : mate>=0)){
                    if (debug) console.log("diff: "+evalDiff)

                    let badgeType = "good";
                    let icon = accuracyIcons["Good"];

                    if (evalDiff <= 15) { badgeType = "best"; icon = accuracyIcons["Best Move"]; }
                    else if (evalDiff <= 40) { badgeType = "excellent"; icon = accuracyIcons["Excellent"]; }
                    else if (evalDiff <= 90) { badgeType = "good"; icon = accuracyIcons["Good"]; }
                    else if (evalDiff <= 150) { badgeType = "inaccuracy"; icon = accuracyIcons["Inaccuracy"]; }
                    else if (evalDiff <= 300) { badgeType = "mistake"; icon = accuracyIcons["Mistake"]; }
                    else { badgeType = "blunder"; icon = accuracyIcons["Blunder"]; }

                    if (debug) console.log("[Move Feedback] " + badgeType)

                    squareBadge = { square: userSquare, icon: icon, type: badgeType };
                    if (historyState[currentHistoryIndex]) {
                        historyState[currentHistoryIndex].badge = squareBadge;
                    }
                }

                drawBoard();

                engineMode = "IDLE";
                if (engineBestMove && engineBestMove !== '(none)') {
                    setTimeout(() => { 
                        handleLocalEngineReply(engineBestMove); 
                    }, 250);
                }
                engineBusy = false;
                processEvaluationQueue();
            }
            else if (engineMode === "RECALCULATING_EVAL") {

                updateEvalBar();

                engineMode = "IDLE";

                engineBusy = false;
                processEvaluationQueue();
            }
        }
    };

    engineWorker.postMessage('uci');
}

initEngine();

const piecesImages = {
    'p': './assets/pieces/black-pawn.png',
    'r': './assets/pieces/black-rook.png',
    'n': './assets/pieces/black-knight.png',
    'b': './assets/pieces/black-bishop.png',
    'q': './assets/pieces/black-queen.png',
    'k': './assets/pieces/black-king.png',
    'P': './assets/pieces/white-pawn.png',
    'R': './assets/pieces/white-rook.png',
    'N': './assets/pieces/white-knight.png',
    'B': './assets/pieces/white-bishop.png',
    'Q': './assets/pieces/white-queen.png',
    'K': './assets/pieces/white-king.png'
};

const accuracyIcons = {
    "Best Move": "★", "Excellent": "👍", "Good": "✓", "Inaccuracy": "?!", "Mistake": "?", "Blunder": "??", "Checkmate": "#", "Draw": "½"
};

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function getSquareCoords(squareName) {
    let col = files.indexOf(squareName[0]);
    let row = 8 - parseInt(squareName[1]);
    if (boardFlipped) { row = 7 - row; col = 7 - col; }
    return { x: col * 100, y: row * 100 };
}

let localPuzzleDatabase = [];

// ======================================================
// KEYBOARD TIME TRAVEL ENGINE
// ======================================================
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.target.tagName === 'INPUT') return;

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) e.preventDefault();

    if (e.key === 'ArrowLeft') {
        if (currentHistoryIndex >= 0) jumpToHistoryMove(currentHistoryIndex - 1);
    } else if (e.key === 'ArrowRight') {
        if (currentHistoryIndex < historyState.length - 1) jumpToHistoryMove(currentHistoryIndex + 1);
    } else if (e.key === 'ArrowUp') {
        jumpToHistoryMove(-1); 
    } else if (e.key === 'ArrowDown') {
        jumpToHistoryMove(historyState.length - 1);
    }
});

// ======================================================
// DATABASE HANDLING & CACHING
// ======================================================

async function handleDatabaseUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    setGameTitle("Parsing database file...");
    const reader = new FileReader();
    
    reader.onload = async function(e) {
        const text = e.target.result;
        const rawGames = text.split(/\n(?=\[Event )/);
        
        localPuzzleDatabase = rawGames.filter(g => g.trim().length > 0).map(gameStr => parseSinglePGN(gameStr));
        
        if (localPuzzleDatabase.length === 0) {
            alert("No valid chess matches identified in this PGN database.");
            return;
        }

        const db = await initIndexedDB();
        if (db) {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            store.clear(); 
            localPuzzleDatabase.forEach(gameData => store.add({ gameData }));
            transaction.oncomplete = function() {
                console.log(` Baltic Cache Saved: ${localPuzzleDatabase.length} items persisted inside IndexedDB.`);
            };
        }

        setGameTitle("Valid database: play a move or press next puzzle");

        // findRandomPuzzle();
    };
    reader.readAsText(file);
}

function parseSinglePGN(pgnString) {
    const getTag = (tag) => {
        const match = pgnString.match(new RegExp(`\\[${tag} "([^"]+)"\\]`));
        return match ? match[1] : "Unknown";
    };
    const fen = getTag("FEN");
    return {
        fen: fen === "Unknown" ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" : fen,
        white: getTag("White"), black: getTag("Black"), raw: pgnString
    };
}

function renderBoardHTML() {
    boardElement.innerHTML = '';
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const row = boardFlipped ? 7 - r : r;
            const col = boardFlipped ? 7 - c : c;
            const squareName = files[col] + (8 - row);
            
            const square = document.createElement('div');
            const isLight = (row + col) % 2 === 0;
            square.classList.add('square', isLight ? 'light' : 'dark');
            square.dataset.square = squareName;

            const pieceData = game.get(squareName);
            if (pieceData) square.classList.add('has-piece');

            if (selectedSquare === squareName) square.classList.add('selected');
            if (lastMoveSquares.includes(squareName)) square.classList.add('last-move');

            if (legalMovesForSelected.includes(squareName)) {
                const dot = document.createElement('div');
                dot.classList.add('legal-dot');
                square.appendChild(dot);
            }

            if (squareBadge && squareBadge.square === squareName) {
                const badge = document.createElement('div');
                badge.classList.add('move-badge', `badge-${squareBadge.type}`);
                badge.textContent = squareBadge.icon;
                square.appendChild(badge);
            }

            square.addEventListener('click', (e) => { e.stopPropagation(); handleSquareClick(squareName); });
            boardElement.appendChild(square);
        }
    }
}

function renderPieces() {
    const boardState = game.board();
    piecesLayer.innerHTML = '';
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const pieceData = boardState[r][c];
            if (pieceData) {
                const squareName = files[c] + (8 - r);
                const lookupKey = pieceData.color === 'w' ? pieceData.type.toUpperCase() : pieceData.type;
                const pieceElement = document.createElement('div');
                pieceElement.classList.add('piece');
                pieceElement.style.backgroundImage = `url('${piecesImages[lookupKey]}')`;
                const coords = getSquareCoords(squareName);
                pieceElement.style.transform = `translate(${coords.x}%, ${coords.y}%)`;
                piecesLayer.appendChild(pieceElement);
            }
        }
    }
}

function updateHistoryUI() {
    historyContainer.innerHTML = '';
    let rowElement = null;

    historyState.forEach((step, idx) => {
        if (idx % 2 === 0) {
            rowElement = document.createElement('div');
            rowElement.classList.add('move-row');
            const moveNum = document.createElement('div');
            moveNum.classList.add('move-number');
            moveNum.textContent = `${Math.floor(idx / 2) + 1}.`;
            rowElement.appendChild(moveNum);
            historyContainer.appendChild(rowElement);
        }

        const moveClickable = document.createElement('div');
        moveClickable.classList.add('move-clickable');
        
        let label = step.san;
        if (step.badge) label += ` ${step.badge.icon}`; 
        moveClickable.textContent = label;
        
        if (idx === currentHistoryIndex) moveClickable.classList.add('active-history-move');
        moveClickable.addEventListener('click', () => jumpToHistoryMove(idx));
        rowElement.appendChild(moveClickable);
    });
    historyContainer.scrollTop = historyContainer.scrollHeight;
}

function jumpToHistoryMove(index) {
    // Standard cleanup
    selectedSquare = null;
    legalMovesForSelected = [];
    currentHistoryIndex = index;

    if (index === -1) {
        game.load(initialFen);
        lastMoveSquares = [];
        squareBadge = null; // Clear badge at start
    } else {
        game.load(historyState[index].fen);
        lastMoveSquares = historyState[index].lastMove;
        // Keep the badge only if it exists in history
        squareBadge = historyState[index].badge || null;
    }
    
    drawBoard();
    updateHistoryUI();
    triggerPassiveEvaluation();
}

function pushMoveToHistory(moveObj, badgeData = null) {
    if (currentHistoryIndex < historyState.length - 1) {
        historyState = historyState.slice(0, currentHistoryIndex + 1);
    }
    historyState.push({
        san: moveObj.san,
        fen: game.fen(),
        lastMove: [moveObj.from, moveObj.to],
        badge: badgeData
    });
    currentHistoryIndex = historyState.length - 1;
    updateHistoryUI();
}

function drawBoard() {
    checkGameEndFeedback();
    renderBoardHTML();
    renderPieces();
    setIndicator(`To Move: ${game.turn() === 'w' ? 'White' : 'Black'}`);
    updateEvalBar();
}

function setIndicator(str){
    const indicator = document.getElementById('turn-indicator');
    indicator.textContent = str;

}

// ======================================================
// SYSTEM SCANNER & WATCHDOG
// ======================================================

function findRandomPuzzle() {
    if (localPuzzleDatabase.length === 0) return;
    console.log(`\n--- 🔍 Starting New Position Scan (Database Size: ${localPuzzleDatabase.length} games) ---`);
    puzzleSearchAttempts = 0;
    engineMode = "SEARCHING_PUZZLE";
    searchNextCandidate();
}

function resetGameState() {
    // Clear UI state artifacts
    selectedSquare = null;
    legalMovesForSelected = [];
    lastMoveSquares = [];
    squareBadge = null;
    
    // Clear the board rendering
    renderBoardHTML();
    renderPieces();
}

function searchNextCandidate() {
    if (!isEngineReady) { setTimeout(searchNextCandidate, 500); return; }
    

    puzzleSearchAttempts++;
    if (puzzleSearchAttempts > MAX_SEARCH_ATTEMPTS) {
        console.error("❌ [STOPPED] Range scan threshold breached.");
        setGameTitle("No balanced positions found. Try a different PGN database.");
        setGameTitle("No balanced positions identified. Try another dataset.");
        engineMode = "IDLE";
        return;
    }

    const gameData = localPuzzleDatabase[Math.floor(Math.random() * localPuzzleDatabase.length)];
    const tempGame = new Chess();
    const pName = `${gameData.white || "Unknown"} vs ${gameData.black || "Unknown"}`;

    try { 
        tempGame.load_pgn(gameData.raw); 
    } catch(e) { 
        setTimeout(searchNextCandidate, 10); 
        return; 
    }

    const moves = tempGame.history({ verbose: true });
    if (moves.length < 15) { 
        setTimeout(searchNextCandidate, 10); 
        return; 
    }

    const ply = Math.floor(Math.random() * (moves.length - 10)) + 10;
    tempGame.reset();
    const historyToLoad = [];
    for(let i=0; i<ply; i++) historyToLoad.push(tempGame.move(moves[i]));

    candidateGameFen = tempGame.fen();
    candidateHistory = historyToLoad;
    candidateGameData = gameData;

    console.log(`🎲 [SEARCHING] #${puzzleSearchAttempts}: "${pName}" at move ${Math.floor(ply/2)}...`);

    // Reset Watchdog
    clearTimeout(engineWatchdog);
    engineWatchdog = setTimeout(() => {
        if (engineMode === "SEARCHING_PUZZLE") {
            console.warn("Unable to find puzzle in time, try reloading or use a better database!");
            searchNextCandidate();
        }
    }, 3500);

    const cleanFen = candidateGameFen.trim();

    if (typeof game !== 'undefined') {
        game.load(cleanFen); 
    }

    engineWorker.postMessage('stop');
    engineWorker.postMessage(`position fen ${cleanFen}`);
    
    pendingSearchSync = true; 
    engineWorker.postMessage('isready'); 
    engineWorker.postMessage('go depth 10');
}

function setupPuzzleBoard(gameData, historyToLoad, fen, initialScore) {
    // 1. Reset everything first
    resetGameState();
    
    currentEval = initialScore;
    engineMode = "IDLE";
    whitePlayerName = gameData.white || "White";
    blackPlayerName = gameData.black || "Black";
    setGameTitle(`${whitePlayerName} vs ${blackPlayerName}`);

    game.reset(); 
    historyState = [];

    for(let i=0; i<historyToLoad.length; i++) {
        let m = game.move(historyToLoad[i]);
        historyState.push({
            san: m.san, fen: game.fen(), lastMove: [m.from, m.to], badge: null
        });
    }

    // Capture the state at the end of the history
    puzzleStartFen = game.fen(); 
    
    currentHistoryIndex = historyState.length - 1;
    
    // 4. Apply the 'last move' highlight based on the current history position
    if (currentHistoryIndex >= 0) {
        lastMoveSquares = historyState[currentHistoryIndex].lastMove;
    }
    
    boardFlipped = (game.turn() === 'b');

    puzzleStartHistoryLength = historyState.length;
    
    triggerPassiveEvaluation();
    updateHistoryUI();
    drawBoard();
}


// ======================================================
// PLY DISPATCH LOOP
// ======================================================

function handleLocalEngineReply(uciMove) {
    const enemyFrom = uciMove.substring(0, 2);
    const enemyTo = uciMove.substring(2, 4);
    const enemyPromo = uciMove.length > 4 ? uciMove[4] : undefined;

    const executedMove = game.move({ from: enemyFrom, to: enemyTo, promotion: enemyPromo });
    if (executedMove) {
        playMoveSound(executedMove);
        lastMoveSquares = [enemyFrom, enemyTo];
        pushMoveToHistory(executedMove);
        drawBoard();
    }
}

async function handleSquareClick(squareName) {
    
    if (game.game_over() || engineMode !== "IDLE") return; 
    if ((boardFlipped && game.turn() === 'w') || (!boardFlipped && game.turn() === 'b')) return;

    if (legalMovesForSelected.includes(squareName)) {
        const originalFrom = selectedSquare;
        const piece = game.get(originalFrom);
        let promotionParam = undefined;
        
        if (piece && piece.type === 'p' && (squareName[1] === '8' || squareName[1] === '1')) {
            promotionParam = 'q'; 
        }

        const moveObj = { from: originalFrom, to: squareName, promotion: promotionParam };
        
        selectedSquare = null;
        legalMovesForSelected = [];
        squareBadge = null;
        
        const executedMove = game.move(moveObj);
        if (!executedMove) return;

        playMoveSound(executedMove);

        lastMoveSquares = [originalFrom, squareName];
        pushMoveToHistory(executedMove);
        drawBoard();

        oldEval = currentEval;

        if (localPuzzleDatabase.length > 0) {
            engineMode = "EVALUATING_USER";
            pendingBadgeSquare = squareName;
            
            currentMultiPvData = {}; // Clear old data remnants completely!

            engineWorker.postMessage('stop');
            engineWorker.postMessage(`position fen ${game.fen()}`);
            engineWorker.postMessage('isready');
            engineWorker.postMessage(`go depth ${maxEngineDepth}`);
            return; 
        }
    }

    const clickedPiece = game.get(squareName);
    if (clickedPiece && clickedPiece.color === game.turn()) {
        if (selectedSquare === squareName) {
            selectedSquare = null;
            legalMovesForSelected = [];
        } else {
            selectedSquare = squareName;
            squareBadge = null; 
            legalMovesForSelected = game.moves({ square: squareName, verbose: true }).map(m => m.to);
        }
    } else {
        selectedSquare = null;
        legalMovesForSelected = [];
    }
    renderBoardHTML();
}

function triggerPassiveEvaluation() {

    pendingFen = game.fen();

    evalPending = true;

    if (engineBusy)
        engineWorker.postMessage("stop");

    processEvaluationQueue();
}

function updateEvalBar() {
    const fillElement = document.getElementById('eval-bar-fill');
    const textElement = document.getElementById('eval-bar-text');
    if (!fillElement || !textElement) return;

    let scoreInCentipawns = currentEval;

    let displayHtml = "";
    let evalValue = scoreInCentipawns / 100;
    let cappedEval = 0;

    if (game.in_checkmate()){
        displayHtml = "gg"
        if (game.turn()==='w'){
            cappedEval = -5.0;
        } else {
            cappedEval = 5.0;
        }
    } else if (game.in_draw()){
        displayHtml = "Draw"
    } else if (mate!=0) {
        displayHtml = `M${Math.abs(mate)}`;
        cappedEval = mate > 0 ? -5 : 5;
    } else {
        if (debug) console.log("eval: " + evalValue);
        if (Math.abs(evalValue) >= 10) {
            displayHtml = Math.round(evalValue);
        } else {
            displayHtml = evalValue.toFixed(1);
        }
        
        if (Math.abs(evalValue) < 0.1) displayHtml = "0.0";
        cappedEval = Math.max(-4.5, Math.min(4.5, evalValue));
    }

    

    let percentage = ((cappedEval + 5) / 10) * 100;
    //if (boardFlipped) percentage = 100 - percentage;

    fillElement.style.height = `${percentage}%`;
    textElement.textContent = displayHtml;

    if (debug) console.log("evalValue: "+evalValue+" | percentage: "+percentage)

    // Dynamic text color adjustment
    if (percentage > 50) {
        textElement.style.top = 'auto';
        textElement.style.bottom = '10px';
        textElement.style.color = '#262421';
    } else {
        textElement.style.bottom = 'auto';
        textElement.style.top = '10px';
        textElement.style.color = '#e1e1e1';
    }
}

function resetBoard() {
    // 1. Reset the internal Chess object to the puzzle start
    game.load(puzzleStartFen);
    
    // 2. FIXED: Truncate history back to the start of the puzzle!
    historyState = historyState.slice(0, puzzleStartHistoryLength); 
    
    // 3. Reset the pointer to the end of the remaining setup moves
    currentHistoryIndex = historyState.length - 1;
    
    // 4. Clear all UI and selection artifacts
    selectedSquare = null;
    legalMovesForSelected = [];
    lastMoveSquares = [];
    squareBadge = null;
    
    // 5. Update UI
    updateHistoryUI();
    drawBoard();
    triggerPassiveEvaluation();
}

// Database Synchronization Core
const DB_NAME = "PGNPuzzleTrainerDB";
const STORE_NAME = "games_cache";

function initIndexedDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = function(e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        };
        request.onsuccess = function(e) { resolve(e.target.result); };
        request.onerror = function() { resolve(null); };
    });
}

function setGameTitle(text) {
    document.getElementById('game-title').textContent = text;
}

async function checkSavedDatabase() {
    const db = await initIndexedDB();
    if (!db) {
        setGameTitle("Error: Failed to access data :( try reloading");
        return;
    }
    
    console.log("📦 [IndexedDB] Checking for cached PGN database...");
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const getAllRequest = store.getAll();
    
    getAllRequest.onsuccess = function() {
        const cachedData = getAllRequest.result;
        if (cachedData && cachedData.length > 0) {
            localPuzzleDatabase = cachedData.map(item => item.gameData);
            console.log(`🔥 [IndexedDB] Cache Hit! Automatically loaded ${localPuzzleDatabase.length} games from storage.`);
            setGameTitle("Valid cached database: play a move or press next puzzle");
            // findRandomPuzzle();
        } else {
            setGameTitle("Use [Load Database] to load puzzle source");
            setIndicator("recommanded source: [https://database.nikonoel.fr/]")
            console.log("💾 [IndexedDB] Cache Empty. Awaiting manual PGN upload.");
        }
    };
}

function exportCurrentPGN() {
    // 1. Fetch headers or create fallbacks
    const whitePlayer = (typeof candidateGameData !== 'undefined' && candidateGameData.white) ? candidateGameData.white : "White Player";
    const blackPlayer = (typeof candidateGameData !== 'undefined' && candidateGameData.black) ? candidateGameData.black : "Black Player";
    
    // Get current date formatted as YYYY.MM.DD
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '.');

    // 2. Build standard PGN headers
    let pgnString = `[Event "Casual Game"]\n`;
    pgnString += `[Site "Local Engine App"]\n`;
    pgnString += `[Date "${today}"]\n`;
    pgnString += `[White "${whitePlayer}"]\n`;
    pgnString += `[Black "${blackPlayer}"]\n`;
    
    // Check game termination status for the Result header
    let result = "*"; // Ongoing/unknown
    if (typeof game.game_over === 'function' && game.game_over()) {
        if (typeof game.in_checkmate === 'function' && game.in_checkmate()) {
            // If it's white's turn, black won; if black's turn, white won
            result = (game.turn() === 'w') ? "0-1" : "1-0";
        } else {
            result = "1/2-1/2"; // Draw/Stalemate/Repetition
        }
    }
    pgnString += `[Result "${result}"]\n\n`;

    // 3. Construct the move text layout
    // game.history() returns an array of move strings like ['e4', 'e5', 'Nf3', ...]
    const moveHistory = game.history();
    let moveText = "";

    for (let i = 0; i < moveHistory.length; i++) {
        if (i % 2 === 0) {
            const moveNumber = Math.floor(i / 2) + 1;
            moveText += `${moveNumber}. ${moveHistory[i]} `;
        } else {
            moveText += `${moveHistory[i]} `;
        }
    }

    // Append final game result token
    pgnString += moveText + result;

    // 4. Copy the completed string directly to clipboard
    navigator.clipboard.writeText(pgnString)
        .then(() => {
            console.log("📋 PGN copied to clipboard successfully!");
            // Optional: Trigger a temporary UI notification toast here
            alert("PGN copied to clipboard!");
        })
        .catch(err => {
            console.error("❌ Failed to copy PGN to clipboard: ", err);
        });
}

checkSavedDatabase();

window.resetBoard = resetBoard;
window.loadNewPuzzle = findRandomPuzzle;
updateHistoryUI();
drawBoard();