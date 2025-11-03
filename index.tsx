import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from '@google/genai';

// --- Constants ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable not set");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });
const PLAYERS_STORAGE_KEY = 'klotski_collaborative_players';
const LAST_PLAYER_STORAGE_KEY = 'klotski_last_player';
const SHARED_GAME_STATE_KEY = 'klotski_shared_game_state'; // Key for real-time state
const GAME_DURATION_SECONDS = 3600; // 60 minutes
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 5;

// --- Sound Effects Engine ---
const sfx = {
  audioCtx: null as AudioContext | null,
  init() {
    if (!this.audioCtx && typeof window !== 'undefined') {
      try {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (e) {
        console.error("Web Audio API is not supported in this browser.");
      }
    }
  },
  
  play(type: 'move' | 'win' | 'click' | 'hint' | 'lose' | 'start') {
    if (!this.audioCtx) return;

    const oscillator = this.audioCtx.createOscillator();
    const gainNode = this.audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(this.audioCtx.destination);
    
    const now = this.audioCtx.currentTime;

    switch (type) {
      case 'move':
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(150, now);
        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        oscillator.start(now);
        oscillator.stop(now + 0.1);
        break;
      
      case 'win':
        const winFrequencies = [440, 550, 660, 880];
        winFrequencies.forEach((freq, i) => {
          const osc = this.audioCtx!.createOscillator();
          const gain = this.audioCtx!.createGain();
          osc.connect(gain);
          gain.connect(this.audioCtx!.destination);
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now + i * 0.1);
          gain.gain.setValueAtTime(0.15, now + i * 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.15);
          osc.start(now + i * 0.1);
          osc.stop(now + i * 0.1 + 0.2);
        });
        break;
      
      case 'lose':
        oscillator.type = 'sawtooth';
        oscillator.frequency.setValueAtTime(220, now);
        oscillator.frequency.exponentialRampToValueAtTime(80, now + 0.5);
        gainNode.gain.setValueAtTime(0.15, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        oscillator.start(now);
        oscillator.stop(now + 0.5);
        break;

      case 'start':
      case 'click':
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(440, now);
        gainNode.gain.setValueAtTime(0.1, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        oscillator.start(now);
        oscillator.stop(now + 0.1);
        break;

      case 'hint':
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(660, now);
        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        oscillator.start(now);
        oscillator.stop(now + 0.3);
        break;
    }
  },
};

// --- Type Definitions ---
interface Player {
  id: string;
  streak: number;
}
type Players = Record<string, Player>;
type LocalView = 'login' | 'ranking' | 'loading'; // Views managed locally

interface Piece {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isGoal: boolean;
}

interface Puzzle {
  boardWidth: number;
  boardHeight: number;
  pieces: Piece[];
  goalPosition: { x: number; y: number };
}

// Represents the state shared across all players in real-time
interface SharedGameState {
    view: 'lobby' | 'game' | 'timesup' | 'win';
    team: string[];
    puzzle: Puzzle | null;
    gameStartTime: number | null; // Timestamp
}

// --- LocalStorage Utilities ---
// Manages individual player data (streaks), which is not real-time
const getPlayersFromStorage = (): Players => {
  try {
    const playersJson = localStorage.getItem(PLAYERS_STORAGE_KEY);
    return playersJson ? JSON.parse(playersJson) : {};
  } catch (error) {
    console.error("Failed to parse players from localStorage", error);
    return {};
  }
};

const savePlayersToStorage = (players: Players) => {
  try {
    localStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(players));
  } catch (error) {
    console.error("Failed to save players to localStorage", error);
  }
};

// --- Shared State Utilities (Simulates Real-time DB) ---
// NOTE: This uses localStorage to simulate a real-time database.
// It works for syncing multiple tabs/windows on the SAME computer.
// For true cross-device multiplayer, replace these functions with calls
// to a service like Firebase Realtime Database.
const getSharedState = (): SharedGameState | null => {
    try {
        const stateJson = localStorage.getItem(SHARED_GAME_STATE_KEY);
        return stateJson ? JSON.parse(stateJson) : null;
    } catch (e) {
        return null;
    }
};

const saveSharedState = (state: SharedGameState) => {
    try {
        // Saving to localStorage will trigger the 'storage' event for other tabs
        localStorage.setItem(SHARED_GAME_STATE_KEY, JSON.stringify(state));
    } catch (e) {
        console.error("Failed to save shared state", e);
    }
};

const resetSharedState = () => {
    saveSharedState({ view: 'lobby', team: [], puzzle: null, gameStartTime: null });
};

// --- Gemini AI Service ---
const getDailySeed = () => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

const generatePuzzle = async (): Promise<Puzzle | null> => {
  try {
    const prompt = `Generate a Klotski puzzle. The board is 4x5. The main piece (2x2) must be moved to the exit at the bottom center. Provide a challenging but solvable layout. The response must be a JSON object. Seed: ${getDailySeed()}`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            boardWidth: { type: Type.INTEGER },
            boardHeight: { type: Type.INTEGER },
            pieces: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.INTEGER },
                  x: { type: Type.INTEGER },
                  y: { type: Type.INTEGER },
                  width: { type: Type.INTEGER },
                  height: { type: Type.INTEGER },
                  isGoal: { type: Type.BOOLEAN },
                },
              },
            },
            goalPosition: {
              type: Type.OBJECT,
              properties: {
                x: { type: Type.INTEGER },
                y: { type: Type.INTEGER },
              },
            },
          },
        },
      },
    });
    const puzzleData = JSON.parse(response.text);
    return puzzleData as Puzzle;
  } catch (error) {
    console.error("Error generating puzzle:", error);
    // Fallback to a default puzzle
    return {
      boardWidth: 4, boardHeight: 5, goalPosition: { x: 1, y: 3 },
      pieces: [
        { id: 1, x: 1, y: 0, width: 2, height: 2, isGoal: true },
        { id: 2, x: 0, y: 0, width: 1, height: 2, isGoal: false },
        { id: 3, x: 3, y: 0, width: 1, height: 2, isGoal: false },
        { id: 4, x: 0, y: 2, width: 1, height: 2, isGoal: false },
        { id: 5, x: 3, y: 2, width: 1, height: 2, isGoal: false },
        { id: 6, x: 1, y: 2, width: 2, height: 1, isGoal: false },
        { id: 7, x: 1, y: 3, width: 1, height: 1, isGoal: false },
        { id: 8, x: 2, y: 3, width: 1, height: 1, isGoal: false },
        { id: 9, x: 0, y: 4, width: 1, height: 1, isGoal: false },
        { id: 10, x: 3, y: 4, width: 1, height: 1, isGoal: false },
      ],
    };
  }
};

// --- UI Components ---

const Loader = () => <div className="loader"></div>;

const Confetti = () => {
  useEffect(() => {
    const container = document.querySelector('.confetti-container');
    if (!container) return;
    for (let i = 0; i < 50; i++) {
      const confetti = document.createElement('div');
      confetti.className = 'confetti';
      confetti.style.left = `${Math.random() * 100}vw`;
      confetti.style.backgroundColor = `hsl(${Math.random() * 360}, 70%, 60%)`;
      confetti.style.animationDuration = `${Math.random() * 3 + 4}s`;
      confetti.style.animationDelay = `${Math.random() * 2}s`;
      container.appendChild(confetti);
    }
  }, []);

  return <div className="confetti-container" aria-hidden="true"></div>;
};

const Timer: React.FC<{ startTime: number; onTimeUp: () => void }> = ({ startTime, onTimeUp }) => {
    const calculateTimeLeft = useCallback(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        return GAME_DURATION_SECONDS - elapsed;
    }, [startTime]);

    const [timeLeft, setTimeLeft] = useState(calculateTimeLeft);
    const isUrgent = timeLeft <= 300; // 5 minutes

    useEffect(() => {
        const intervalId = setInterval(() => {
            const newTimeLeft = calculateTimeLeft();
            if (newTimeLeft <= 0) {
                onTimeUp();
                setTimeLeft(0);
                clearInterval(intervalId);
            } else {
                setTimeLeft(newTimeLeft);
            }
        }, 1000);

        return () => clearInterval(intervalId);
    }, [calculateTimeLeft, onTimeUp]);

    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;

    return (
        <div className={`timer ${isUrgent ? 'urgent' : ''}`} role="timer" aria-live="assertive">
            {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
        </div>
    );
};

const LoginScreen: React.FC<{ onLogin: (id: string) => void; lastPlayerId: string | null }> = ({ onLogin, lastPlayerId }) => {
    const [id, setId] = useState(lastPlayerId || '');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (id.trim()) {
            sfx.play('click');
            onLogin(id.trim());
        }
    };

    return (
        <div className="app-container">
            <h1 className="title">Move!</h1>
            <p className="subtitle">Juego del Trabado Colaborativo</p>
            <form onSubmit={handleSubmit}>
                <div className="input-group">
                    <input
                        type="email"
                        value={id}
                        onChange={(e) => setId(e.target.value)}
                        className="input-field"
                        placeholder="Ingresa tu email o nombre"
                        aria-label="Email o nombre de usuario"
                        required
                    />
                </div>
                <button type="submit" className="btn btn-primary" disabled={!id.trim()}>
                    Entrar
                </button>
            </form>
        </div>
    );
};

const RankingScreen: React.FC<{ players: Players; currentPlayerId: string; onBack: () => void }> = ({ players, currentPlayerId, onBack }) => {
    // FIX: Explicitly typing the sort function parameters ensures correct type inference downstream,
    // preventing the 'player' variable in the map function from being typed as 'unknown'.
    const sortedPlayers = Object.values(players).sort((a: Player, b: Player) => b.streak - a.streak);

    return (
        <div className="app-container">
            <h1 className="title">Ranking de Rachas</h1>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                <table className="ranking-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Jugador</th>
                            <th>Racha 🔥</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sortedPlayers.map((player, index) => (
                            <tr key={player.id} className={player.id === currentPlayerId ? 'current-player' : ''}>
                                <td>{index + 1}</td>
                                <td style={{ wordBreak: 'break-all' }}>{player.id}</td>
                                <td>{player.streak}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="button-group">
                <button onClick={() => { sfx.play('click'); onBack(); }} className="btn btn-primary">
                    Volver al Lobby
                </button>
            </div>
        </div>
    );
};

const LobbyScreen: React.FC<{
    currentPlayer: Player;
    team: string[];
    onStartGame: () => void;
    onJoinOrLeave: () => void;
    onViewRankings: () => void;
    onLogout: () => void;
}> = ({ currentPlayer, team, onStartGame, onJoinOrLeave, onViewRankings, onLogout }) => {
    const isInTeam = team.includes(currentPlayer.id);
    const canStartGame = team.length >= MIN_PLAYERS && team.length <= MAX_PLAYERS;

    return (
        <div className="app-container">
            <h1 className="title">Lobby</h1>
            <p className="subtitle">¡Prepara tu equipo para el desafío diario!</p>
            <p>Bienvenido, <strong>{currentPlayer.id}</strong></p>
            <p>Tu racha actual: 🔥 {currentPlayer.streak}</p>

            <h3>Equipo Actual ({team.length}/{MAX_PLAYERS})</h3>
            <ul className="player-list">
                {team.length > 0 ? team.map(playerId => <li key={playerId} className="player-list-item">{playerId}</li>) : <li>El equipo está vacío.</li>}
            </ul>
            
            {!canStartGame && <p style={{color: 'var(--color-warning)'}}>Se necesitan entre {MIN_PLAYERS} y {MAX_PLAYERS} jugadores para empezar.</p>}

            <div className="button-group">
                <button onClick={onStartGame} className="btn btn-primary" disabled={!canStartGame}>
                    Empezar Juego
                </button>
                <button onClick={onJoinOrLeave} className="btn btn-secondary">
                    {isInTeam ? 'Salir del Equipo' : 'Unirse al Equipo'}
                </button>
                <button onClick={onViewRankings} className="btn btn-tertiary">
                    Ver Ranking
                </button>
                <button onClick={onLogout} className="btn btn-tertiary" style={{borderColor: 'var(--color-subtext)', color: 'var(--color-subtext)'}}>
                    Cerrar Sesión
                </button>
            </div>
        </div>
    );
};

const TimesUpScreen: React.FC<{ onBackToLobby: () => void }> = ({ onBackToLobby }) => {
    useEffect(() => {
        sfx.play('lose');
    }, []);
    return (
        <div className="modal-overlay">
            <div className="app-container modal-content">
                <h1 className="title" style={{color: 'var(--color-danger)'}}>¡Tiempo Agotado!</h1>
                <p className="subtitle">La racha del equipo ha sido reiniciada. ¡Mejor suerte la próxima vez!</p>
                <button onClick={() => { sfx.play('click'); onBackToLobby(); }} className="btn btn-primary">
                    Volver al Lobby
                </button>
            </div>
        </div>
    );
};

const WinScreen: React.FC<{ onBackToLobby: () => void; streak: number; }> = ({ onBackToLobby, streak }) => {
    useEffect(() => {
        sfx.play('win');
    }, []);
    return (
        <>
        <Confetti/>
        <div className="modal-overlay">
            <div className="app-container modal-content">
                <h1 className="title" style={{color: 'var(--color-success)'}}>¡Puzzle Resuelto!</h1>
                <p className="subtitle">¡Excelente trabajo en equipo! Su racha ha aumentado.</p>
                <p style={{textAlign: 'center', fontSize: '1.5rem', margin: '1rem 0'}}>Racha actual: 🔥 <strong>{streak}</strong></p>
                <button onClick={() => { sfx.play('click'); onBackToLobby(); }} className="btn btn-primary">
                    Volver al Lobby
                </button>
            </div>
        </div>
        </>
    );
};


// --- Game Component ---
const GameScreen: React.FC<{ 
    puzzle: Puzzle; 
    onWin: () => void; 
    onTimeUp: () => void;
    onPuzzleChange: (newPuzzle: Puzzle) => void;
    team: string[];
    startTime: number;
}> = ({ puzzle, onWin, onTimeUp, onPuzzleChange, team, startTime }) => {
    const [dragging, setDragging] = useState<{ id: number; startX: number; startY: number; pieceStartX: number; pieceStartY: number } | null>(null);
    const boardRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    
    const checkWinCondition = useCallback(() => {
        const goalPiece = puzzle.pieces.find(p => p.isGoal);
        if (goalPiece && goalPiece.x === puzzle.goalPosition.x && goalPiece.y === puzzle.goalPosition.y) {
            onWin();
        }
    }, [puzzle, onWin]);

    useEffect(() => {
        checkWinCondition();
    }, [puzzle.pieces, checkWinCondition]);
    
    useEffect(() => {
        const calculateScale = () => {
            if (boardRef.current) {
                const { width, height } = boardRef.current.parentElement!.getBoundingClientRect();
                const scaleX = width / (puzzle.boardWidth * 100);
                const scaleY = height / (puzzle.boardHeight * 100);
                setScale(Math.min(scaleX, scaleY, 1));
            }
        };
        calculateScale();
        window.addEventListener('resize', calculateScale);
        return () => window.removeEventListener('resize', calculateScale);
    }, [puzzle.boardWidth, puzzle.boardHeight]);

    const handleDragStart = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>, id: number) => {
        e.preventDefault();
        const piece = puzzle.pieces.find(p => p.id === id);
        if (!piece) return;
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
        setDragging({ id, startX: clientX, startY: clientY, pieceStartX: piece.x, pieceStartY: piece.y });
    };

    const handleDragMove = useCallback((e: MouseEvent | TouchEvent) => {
        if (!dragging) return;
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

        const deltaX = (clientX - dragging.startX) / (100 * scale);
        const deltaY = (clientY - dragging.startY) / (100 * scale);

        let newX = dragging.pieceStartX + deltaX;
        let newY = dragging.pieceStartY + deltaY;

        const pieceRef = document.getElementById(`piece-${dragging.id}`);
        if(pieceRef) {
          pieceRef.style.transform = `translate(${newX * 100}px, ${newY * 100}px)`;
        }
    }, [dragging, scale]);

    const handleDragEnd = useCallback((e: MouseEvent | TouchEvent) => {
      if (!dragging) return;
      const piece = puzzle.pieces.find(p => p.id === dragging.id)!;

      const clientX = 'changedTouches' in e ? e.changedTouches[0].clientX : e.clientX;
      const clientY = 'changedTouches' in e ? e.changedTouches[0].clientY : e.clientY;

      const deltaX = (clientX - dragging.startX) / (100 * scale);
      const deltaY = (clientY - dragging.startY) / (100 * scale);

      const targetX = Math.round(dragging.pieceStartX + deltaX);
      const targetY = Math.round(dragging.pieceStartY + deltaY);
      
      const dx = targetX - piece.x;
      const dy = targetY - piece.y;

      let finalX = piece.x;
      let finalY = piece.y;

      if (Math.abs(dx) > Math.abs(dy)) { // Horizontal movement
        const dir = Math.sign(dx);
        for (let i = 1; i <= Math.abs(dx); i++) {
          const nextX = piece.x + i * dir;
          if (!isOccupied(nextX, piece.y, piece.width, piece.height, piece.id)) {
            finalX = nextX;
          } else break;
        }
      } else { // Vertical movement
        const dir = Math.sign(dy);
        for (let i = 1; i <= Math.abs(dy); i++) {
          const nextY = piece.y + i * dir;
          if (!isOccupied(piece.x, nextY, piece.width, piece.height, piece.id)) {
            finalY = nextY;
          } else break;
        }
      }
      
      if(finalX !== piece.x || finalY !== piece.y) {
        sfx.play('move');
        const newPieces = puzzle.pieces.map(p => p.id === dragging.id ? { ...p, x: finalX, y: finalY } : p)
        onPuzzleChange({ ...puzzle, pieces: newPieces });
      } else {
        // If no valid move, snap back visually
        const pieceRef = document.getElementById(`piece-${piece.id}`);
        if(pieceRef) pieceRef.style.transform = `translate(${piece.x * 100}px, ${piece.y * 100}px)`;
      }

      setDragging(null);

    }, [dragging, puzzle, scale, onPuzzleChange]);

    useEffect(() => {
        document.addEventListener('mousemove', handleDragMove);
        document.addEventListener('touchmove', handleDragMove);
        document.addEventListener('mouseup', handleDragEnd);
        document.addEventListener('touchend', handleDragEnd);

        return () => {
            document.removeEventListener('mousemove', handleDragMove);
            document.removeEventListener('touchmove', handleDragMove);
            document.removeEventListener('mouseup', handleDragEnd);
            document.removeEventListener('touchend', handleDragEnd);
        };
    }, [handleDragMove, handleDragEnd]);

    const isOccupied = (x: number, y: number, w: number, h: number, excludeId: number) => {
        if (x < 0 || y < 0 || x + w > puzzle.boardWidth || y + h > puzzle.boardHeight) return true;
        for (const p of puzzle.pieces) {
            if (p.id === excludeId) continue;
            if (!(x + w <= p.x || x >= p.x + p.width || y + h <= p.y || y >= p.y + p.height)) {
                return true;
            }
        }
        return false;
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', justifyContent: 'center', alignItems: 'center', padding: '1rem', backgroundColor: 'var(--color-background)' }}>
            <Timer startTime={startTime} onTimeUp={onTimeUp} />
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                {team.map(id => <span key={id} style={{padding: '0.25rem 0.5rem', background: 'var(--color-input-bg)', borderRadius: '6px'}}>{id}</span>)}
            </div>
            <div ref={boardRef} style={{
                position: 'relative',
                width: `${puzzle.boardWidth * 100 * scale}px`,
                height: `${puzzle.boardHeight * 100 * scale}px`,
                backgroundColor: 'var(--color-board-bg)',
                border: `4px solid var(--color-board-border)`,
                borderRadius: '10px',
            }}>
                {puzzle.pieces.map(p => (
                    <div
                        key={p.id}
                        id={`piece-${p.id}`}
                        className={`piece ${dragging?.id === p.id ? 'dragging' : ''}`}
                        onMouseDown={(e) => handleDragStart(e, p.id)}
                        onTouchStart={(e) => handleDragStart(e, p.id)}
                        style={{
                            position: 'absolute',
                            width: `${p.width * 100 * scale}px`,
                            height: `${p.height * 100 * scale}px`,
                            transform: `translate(${p.x * 100 * scale}px, ${p.y * 100 * scale}px)`,
                            backgroundColor: p.isGoal ? 'var(--color-secondary-accent)' : 'var(--color-primary-accent)',
                            border: `2px solid var(--color-piece-border)`,
                            borderRadius: '8px',
                            cursor: 'grab',
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            fontSize: `${20 * scale}px`,
                            color: 'white',
                            boxShadow: p.isGoal ? 'inset 0 -4px var(--color-goal-piece-shadow)' : 'inset 0 -4px rgba(0,0,0,0.2)',
                            zIndex: dragging?.id === p.id ? 10 : 1,
                        }}
                    >
                    </div>
                ))}
            </div>
             <div style={{
                position: 'absolute',
                bottom: `calc(50% - ${puzzle.boardHeight * 100 * scale / 2}px - 20px)`,
                left: `calc(50% + ${ (puzzle.goalPosition.x - puzzle.boardWidth/2) * 100 * scale}px)`,
                width: `${puzzle.pieces.find(p => p.isGoal)!.width * 100 * scale}px`,
                height: '10px',
                backgroundColor: 'var(--color-tertiary-accent)',
                borderRadius: '5px'
             }}></div>
        </div>
    );
};


// --- Main App Component ---
const App = () => {
    const [localView, setLocalView] = useState<LocalView>('login');
    const [players, setPlayers] = useState<Players>(getPlayersFromStorage());
    const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);
    const [sharedState, setSharedState] = useState<SharedGameState | null>(getSharedState());
    
    // Effect for initializing and syncing shared state
    useEffect(() => {
        sfx.init();
        
        // On first load, if no shared state exists, create one (for the first player)
        if (!getSharedState()) {
            resetSharedState();
        }

        // Listen for changes from other tabs/windows
        const handleStorageChange = (event: StorageEvent) => {
            if (event.key === SHARED_GAME_STATE_KEY) {
                setSharedState(getSharedState());
            }
        };
        window.addEventListener('storage', handleStorageChange);

        const lastPlayer = localStorage.getItem(LAST_PLAYER_STORAGE_KEY);
        if (lastPlayer) {
            setCurrentPlayerId(lastPlayer);
            setLocalView('loading'); // Go to loading, which will redirect to lobby
        }
        
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);

    const handleLogin = (id: string) => {
        const existingPlayer = players[id];
        if (!existingPlayer) {
            const newPlayer = { id, streak: 0 };
            const updatedPlayers = { ...players, [id]: newPlayer };
            setPlayers(updatedPlayers);
            savePlayersToStorage(updatedPlayers);
        }
        setCurrentPlayerId(id);
        localStorage.setItem(LAST_PLAYER_STORAGE_KEY, id);
        setLocalView('loading'); // Will redirect to lobby
    };

    const handleLogout = () => {
        sfx.play('click');
        handleJoinOrLeaveTeam(true); // Force leave team on logout
        setCurrentPlayerId(null);
        localStorage.removeItem(LAST_PLAYER_STORAGE_KEY);
        setLocalView('login');
    };

    const handleJoinOrLeaveTeam = (forceLeave = false) => {
        sfx.play('click');
        if (!currentPlayerId || !sharedState) return;

        const isInTeam = sharedState.team.includes(currentPlayerId);
        let newTeam;
        if (forceLeave) {
            newTeam = sharedState.team.filter(pId => pId !== currentPlayerId);
        } else {
            newTeam = isInTeam
                ? sharedState.team.filter(pId => pId !== currentPlayerId)
                : [...sharedState.team, currentPlayerId];
        }
        
        const newState = { ...sharedState, team: newTeam };
        saveSharedState(newState);
        setSharedState(newState); // Update local state immediately
    };

    const handleStartGame = async () => {
        sfx.play('start');
        setLocalView('loading');
        const generatedPuzzle = await generatePuzzle();
        if (generatedPuzzle && sharedState) {
            const newState = { 
                ...sharedState,
                puzzle: generatedPuzzle,
                view: 'game' as 'game',
                gameStartTime: Date.now(),
            };
            saveSharedState(newState);
            setSharedState(newState);
        } else {
            setLocalView('loading'); // Back to lobby
        }
    };
    
    const handleWin = () => {
        if(!sharedState || sharedState.view !== 'game') return; // Prevent multiple triggers

        const updatedPlayers = { ...players };
        sharedState.team.forEach(playerId => {
            if (updatedPlayers[playerId]) {
                updatedPlayers[playerId].streak += 1;
            }
        });
        setPlayers(updatedPlayers);
        savePlayersToStorage(updatedPlayers);
        
        const newState = { ...sharedState, view: 'win' as 'win' };
        saveSharedState(newState);
        setSharedState(newState);
    };
    
    const handlePuzzleChange = (newPuzzle: Puzzle) => {
        if(sharedState) {
             const newState = { ...sharedState, puzzle: newPuzzle };
             saveSharedState(newState);
             setSharedState(newState);
        }
    }

    const handleTimeUp = () => {
        if(!sharedState || sharedState.view !== 'game') return; // Prevent multiple triggers
        
        const updatedPlayers = { ...players };
        sharedState.team.forEach(playerId => {
            if (updatedPlayers[playerId]) {
                updatedPlayers[playerId].streak = 0;
            }
        });
        setPlayers(updatedPlayers);
        savePlayersToStorage(updatedPlayers);

        const newState = { ...sharedState, view: 'timesup' as 'timesup' };
        saveSharedState(newState);
        setSharedState(newState);
    };

    const handleBackToLobby = () => {
        // Only one player needs to reset the state for everyone
        resetSharedState();
        setSharedState(getSharedState());
    };

    const renderView = () => {
        if (localView === 'login' || !currentPlayerId) {
             const lastPlayer = localStorage.getItem(LAST_PLAYER_STORAGE_KEY);
             return <LoginScreen onLogin={handleLogin} lastPlayerId={lastPlayer}/>;
        }
        
        if (localView === 'ranking') {
            return <RankingScreen players={players} currentPlayerId={currentPlayerId} onBack={() => setLocalView('loading')}/>;
        }
        
        if (!sharedState || localView === 'loading') {
             return <div className="app-container"><h1 className="title">Sincronizando...</h1><Loader/></div>;
        }

        switch (sharedState.view) {
            case 'lobby':
                if (players[currentPlayerId]) {
                    return <LobbyScreen
                        currentPlayer={players[currentPlayerId]}
                        team={sharedState.team}
                        onStartGame={handleStartGame}
                        onJoinOrLeave={() => handleJoinOrLeaveTeam()}
                        onViewRankings={() => { sfx.play('click'); setLocalView('ranking'); }}
                        onLogout={handleLogout}
                    />;
                }
                break;
            case 'game':
                if (sharedState.puzzle && sharedState.gameStartTime) {
                    return <GameScreen 
                        puzzle={sharedState.puzzle} 
                        onWin={handleWin} 
                        onTimeUp={handleTimeUp} 
                        onPuzzleChange={handlePuzzleChange}
                        team={sharedState.team}
                        startTime={sharedState.gameStartTime}
                    />;
                }
                break;
            case 'win':
                 return <WinScreen onBackToLobby={handleBackToLobby} streak={players[currentPlayerId]?.streak ?? 0}/>
            case 'timesup':
                return <TimesUpScreen onBackToLobby={handleBackToLobby}/>;
        }

        // Fallback or default view
        return <div>Error: Vista desconocida o estado inválido.</div>;
    };

    return <>{renderView()}</>;
};

// --- Root Render ---
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
