const io = require('socket.io-client');

const socket = io('http://localhost:4000');

socket.on('connect', () => {
  console.log('Connected to server');
  
  // Register Ana
  socket.emit('register_user', { userId: 'guest_1779916907740_731' });
  socket.emit('join_room', { roomId: 'LOBBY', userId: 'guest_1779916907740_731' });
  
  setTimeout(() => {
    console.log('Placing settlement at vertex 5');
    socket.emit('game_action', { 
      roomId: 'LOBBY', 
      userId: 'guest_1779916907740_731', 
      action: { type: 'setup_place_settlement', vertexId: 5 } 
    }, (result) => {
      console.log('Settlement placement result:', result);
      
      if (result.ok) {
        // If settlement succeeded, place the road
        setTimeout(() => {
          console.log('Placing road at edge 4');
          socket.emit('game_action', { 
            roomId: 'LOBBY', 
            userId: 'guest_1779916907740_731', 
            action: { type: 'setup_place_road', edgeId: 4 } 
          }, (result2) => {
            console.log('Road placement result:', result2);
            
            socket.disconnect();
          });
        }, 500);
      }
    });
  }, 1000);
});

socket.on('room_update', (state) => {
  console.log('Room updated, phase:', state.phase);
});

socket.on('error', (msg) => {
  console.error('Error:', msg);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err);
});
