const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

// 資料結構：儲存多個房間的狀態
// rooms[roomId] = { players: {}, pellets: [], usedColors: [] }
let rooms = {};
const MAX_PELLETS = 50;
const WORLD_SIZE = 800; // 地圖範圍 -800 到 800

// 產生隨機房間代碼
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 在 3D 空間產生光點
function spawnPellet() {
    return { 
        x: (Math.random() - 0.5) * WORLD_SIZE * 2, 
        y: 4, // 光點貼在地上 (假設光點半徑為4)
        z: (Math.random() - 0.5) * WORLD_SIZE * 2 
    };
}

io.on('connection', (socket) => {
    console.log('新玩家連線:', socket.id);
    let currentRoom = null;

    // 1. 創建房間
    socket.on('create_room', () => {
        const roomId = generateRoomCode();
        rooms[roomId] = { players: {}, pellets: [], usedColors: [] };
        
        // 初始生成光點
        for (let i = 0; i < MAX_PELLETS; i++) {
            rooms[roomId].pellets.push(spawnPellet());
        }

        socket.join(roomId);
        currentRoom = roomId;
        socket.emit('room_joined', roomId);
    });

    // 2. 加入房間
    socket.on('join_room', (roomId) => {
        roomId = roomId.toUpperCase();
        if (rooms[roomId]) {
            socket.join(roomId);
            currentRoom = roomId;
            socket.emit('room_joined', roomId);
        } else {
            socket.emit('room_error', '找不到該房間！');
        }
    });

    // 3. 選擇顏色並進入戰場
    socket.on('join_game', (data) => {
        const roomId = data.roomId;
        const color = data.color;

        if (!rooms[roomId]) return socket.emit('color_error', '房間已不存在');
        if (rooms[roomId].usedColors.includes(color)) {
            return socket.emit('color_error', '這個顏色已經被選走了，請換一個！');
        }

        // 註冊玩家顏色與初始狀態 (3D 座標, 包含 y 軸和垂直速度 vy)
        rooms[roomId].usedColors.push(color);
        rooms[roomId].players[socket.id] = {
            x: (Math.random() - 0.5) * 500,
            y: 20, // 初始高度
            z: (Math.random() - 0.5) * 500,
            vy: 0, // 垂直速度 (重力用)
            radius: 20,
            color: color,
            input: { dx: 0, dz: 0, jump: false } // 存放客戶端傳來的意圖
        };

        socket.emit('game_started');
        console.log(`玩家 ${socket.id} 加入房間 ${roomId} (顏色: ${color})`);
    });

    // 4. 接收玩家操作 (僅更新意圖，交由遊戲迴圈結算)
    socket.on('player_input', (input) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].input = input;
        }
    });

    // 5. 斷線清理
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            const player = room.players[socket.id];
            
            if (player) {
                // 釋放顏色
                room.usedColors = room.usedColors.filter(c => c !== player.color);
                delete room.players[socket.id];
            }

            // 如果房間空了，自動銷毀房間節省資源
            if (Object.keys(room.players).length === 0) {
                delete rooms[currentRoom];
                console.log(`房間 ${currentRoom} 已銷毀`);
            }
        }
        console.log('玩家離線:', socket.id);
    });
});

// --- 伺服器核心遊戲迴圈 (30ms) ---
setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId];
        let players = room.players;
        let pellets = room.pellets;

        // 1. 玩家移動與物理 (重力與跳躍)
        for (let id in players) {
            let p = players[id];
            let input = p.input;

            let speed = Math.max(2, 6 - (p.radius - 20) * 0.1); 
            p.x += input.dx * speed;
            p.z += input.dz * speed;

            // Y 軸物理：重力
            p.vy -= 1.5; // 重力加速度
            p.y += p.vy;

            // 地板碰撞 (y = 0 是地面，球體的底部不能穿過地面)
            let isGrounded = false;
            // 【修改點1】必須在場地範圍內 (WORLD_SIZE) 才會有地板擋住，超過範圍球就會繼續往下掉
            if (Math.abs(p.x) <= WORLD_SIZE && Math.abs(p.z) <= WORLD_SIZE) {
                if (p.y <= p.radius) {
                    p.y = p.radius; // 卡在地表
                    p.vy = 0;
                    isGrounded = true;
                }
            }

            // 跳躍判定
            if (input.jump && isGrounded) {
                p.vy = 25; 
                input.jump = false; 
            }
        }

            // 跳躍判定
            if (input.jump && isGrounded) {
                p.vy = 25; // 給予向上的速度
                input.jump = false; // 消耗掉跳躍指令
            }
        }

        // 2. 判定：玩家吃光點 (3D 距離判斷)
        for (let id in players) {
            let p = players[id];
            for (let i = pellets.length - 1; i >= 0; i--) {
                // 3D 空間距離公式
                let dist = Math.hypot(p.x - pellets[i].x, p.y - pellets[i].y, p.z - pellets[i].z);
                if (dist < p.radius) {
                    pellets.splice(i, 1);       
                    p.radius += 1;              
                    pellets.push(spawnPellet());
                }
            }
        }

        // 3. 判定：大球撞小球 (推力取代直接吃掉)
        let playerIds = Object.keys(players);
        for (let i = 0; i < playerIds.length; i++) {
            for (let j = i + 1; j < playerIds.length; j++) {
                let p1 = players[playerIds[i]];
                let p2 = players[playerIds[j]];
                if (!p1 || !p2) continue;

                let dist = Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
                if (dist < p1.radius + p2.radius) {
                    let angle = Math.atan2(p1.z - p2.z, p1.x - p2.x);
                    let force = 30; // 撞擊力道
                    
                    if (p1.radius > p2.radius * 1.1) {
                        p2.x += Math.cos(angle) * force;
                        p2.z += Math.sin(angle) * force;
                    } else if (p2.radius > p1.radius * 1.1) {
                        p1.x -= Math.cos(angle) * force;
                        p1.z -= Math.sin(angle) * force;
                    }
                }
            }
        }

        // 4. 邊界檢查與重生 
        for (let id in players) {
            let p = players[id];
            // 【修改點2】球的中心點 (p.y) 加上半徑 (p.radius) 小於 0，代表整顆球都掉到地板底下了
            if (p.y + p.radius < 0) {
                io.to(id).emit('you_lost', '你掉入虛空了！復活中...');
                
                // 重置狀態 (直接在當前房間給予隨機座標)
                p.x = (Math.random() - 0.5) * WORLD_SIZE;
                p.z = (Math.random() - 0.5) * WORLD_SIZE;
                p.y = 100;     // 從天上掉下來，比較有重生的感覺
                p.vy = 0;
                p.radius = 20; // 回復最小體型
            }
        }

        // 4. 只廣播給該房間的玩家
        io.to(roomId).emit('update_game_state', { players, pellets });
    }
}, 30);

http.listen(3000, () => console.log('伺服器在 3000 port 運行中...'));
