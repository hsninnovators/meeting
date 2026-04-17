<?php
declare(strict_types=1);

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$roomsDir = __DIR__ . '/rooms';
if (!is_dir($roomsDir)) {
    mkdir($roomsDir, 0775, true);
}

function out(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function roomPath(string $roomId): string {
    global $roomsDir;
    return $roomsDir . '/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $roomId) . '.json';
}

function now(): int {
    return time();
}

function parseMaybeJson($value) {
    if (!is_string($value)) return $value;
    $trim = trim($value);
    if ($trim === '') return $value;
    if (($trim[0] === '{' && str_ends_with($trim, '}')) || ($trim[0] === '[' && str_ends_with($trim, ']'))) {
        $decoded = json_decode($trim, true);
        if (json_last_error() === JSON_ERROR_NONE) return $decoded;
    }
    return $value;
}

function readRoom(string $roomId): ?array {
    $path = roomPath($roomId);
    if (!file_exists($path)) return null;
    $json = file_get_contents($path);
    if ($json === false) return null;
    $data = json_decode($json, true);
    if (!is_array($data)) return null;
    return $data;
}

function writeRoom(string $roomId, array $room): bool {
    $path = roomPath($roomId);
    $fp = fopen($path, 'c+');
    if (!$fp) return false;

    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        return false;
    }

    ftruncate($fp, 0);
    rewind($fp);
    $ok = fwrite($fp, json_encode($room, JSON_PRETTY_PRINT)) !== false;
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $ok;
}

function initRoom(string $roomId, string $hostId, string $name): array {
    return [
        'room_id' => $roomId,
        'created_at' => now(),
        'users' => [
            $hostId => [
                'user_id' => $hostId,
                'name' => $name,
                'is_host' => true,
                'hand_raised' => false,
                'joined_at' => now(),
                'last_seen' => now()
            ]
        ],
        'signals' => [
            'offers' => [],
            'answers' => [],
            'ice' => []
        ],
        'chat' => [],
        'commands' => [],
        'seq' => [
            'offer' => 0,
            'answer' => 0,
            'ice' => 0,
            'chat' => 0,
            'command' => 0
        ]
    ];
}

function cleanupRoom(array &$room): void {
    $cutoff = now() - 40;
    foreach ($room['users'] as $uid => $u) {
        if (($u['last_seen'] ?? 0) < $cutoff) {
            unset($room['users'][$uid]);
        }
    }

    if (!empty($room['users'])) {
        $hasHost = false;
        foreach ($room['users'] as $u) {
            if (!empty($u['is_host'])) $hasHost = true;
        }
        if (!$hasHost) {
            $firstKey = array_key_first($room['users']);
            $room['users'][$firstKey]['is_host'] = true;
        }
    }

    foreach (['offers' => 'offer', 'answers' => 'answer', 'ice' => 'ice'] as $type => $_) {
        $room['signals'][$type] = array_values(array_filter(
            $room['signals'][$type],
            fn($x) => ($x['ts'] ?? 0) > now() - 3600
        ));
    }
    $room['chat'] = array_values(array_filter($room['chat'], fn($x) => ($x['ts'] ?? 0) > now() - 86400));
    $room['commands'] = array_values(array_filter($room['commands'], fn($x) => ($x['ts'] ?? 0) > now() - 3600));
}

function getPost(string $key, $default = '') {
    return $_POST[$key] ?? $default;
}

$action = getPost('action');
if ($action === '') out(['ok' => false, 'error' => 'Missing action'], 400);

if ($action === 'create_room') {
    $userId = trim((string)getPost('user_id'));
    $name = trim((string)getPost('name', 'Host'));
    if ($userId === '') out(['ok' => false, 'error' => 'Missing user_id'], 400);

    do {
        $roomId = bin2hex(random_bytes(4));
        $path = roomPath($roomId);
    } while (file_exists($path));

    $room = initRoom($roomId, $userId, $name);
    if (!writeRoom($roomId, $room)) out(['ok' => false, 'error' => 'Failed to create room'], 500);
    out(['ok' => true, 'room_id' => $roomId]);
}

$roomId = trim((string)getPost('room_id'));
if ($roomId === '') out(['ok' => false, 'error' => 'Missing room_id'], 400);
$room = readRoom($roomId);
if (!$room) out(['ok' => false, 'error' => 'Room not found'], 404);

$userId = trim((string)getPost('user_id', ''));

if ($action === 'join_room') {
    $name = trim((string)getPost('name', 'Guest'));
    if ($userId === '') out(['ok' => false, 'error' => 'Missing user_id'], 400);

    $exists = isset($room['users'][$userId]);
    $room['users'][$userId] = [
        'user_id' => $userId,
        'name' => $name,
        'is_host' => $exists ? !empty($room['users'][$userId]['is_host']) : empty($room['users']),
        'hand_raised' => $exists ? !empty($room['users'][$userId]['hand_raised']) : false,
        'joined_at' => $exists ? (int)$room['users'][$userId]['joined_at'] : now(),
        'last_seen' => now()
    ];
    cleanupRoom($room);
    writeRoom($roomId, $room);
    out(['ok' => true, 'is_host' => $room['users'][$userId]['is_host']]);
}

if ($action === 'heartbeat') {
    if ($userId !== '' && isset($room['users'][$userId])) {
        $room['users'][$userId]['last_seen'] = now();
    }
    cleanupRoom($room);
    writeRoom($roomId, $room);
    out(['ok' => true]);
}

if ($action === 'get_users') {
    cleanupRoom($room);
    writeRoom($roomId, $room);
    out(['ok' => true, 'users' => array_values($room['users'])]);
}

if ($action === 'send_offer') {
    $targetId = trim((string)getPost('target_id'));
    $sdp = parseMaybeJson(getPost('sdp', ''));
    if ($userId === '' || $targetId === '' || !$sdp) out(['ok' => false, 'error' => 'Missing fields'], 400);
    $id = ++$room['seq']['offer'];
    $room['signals']['offers'][] = ['id' => $id, 'from' => $userId, 'to' => $targetId, 'sdp' => $sdp, 'ts' => now()];
    writeRoom($roomId, $room);
    out(['ok' => true, 'id' => $id]);
}

if ($action === 'get_offers') {
    $since = (int)getPost('since_id', 0);
    $items = array_values(array_filter($room['signals']['offers'], fn($x) => $x['to'] === $userId && $x['id'] > $since));
    $last = $since;
    foreach ($items as $it) $last = max($last, (int)$it['id']);
    out(['ok' => true, 'items' => $items, 'last_id' => $last]);
}

if ($action === 'send_answer') {
    $targetId = trim((string)getPost('target_id'));
    $sdp = parseMaybeJson(getPost('sdp', ''));
    if ($userId === '' || $targetId === '' || !$sdp) out(['ok' => false, 'error' => 'Missing fields'], 400);
    $id = ++$room['seq']['answer'];
    $room['signals']['answers'][] = ['id' => $id, 'from' => $userId, 'to' => $targetId, 'sdp' => $sdp, 'ts' => now()];
    writeRoom($roomId, $room);
    out(['ok' => true, 'id' => $id]);
}

if ($action === 'get_answers') {
    $since = (int)getPost('since_id', 0);
    $items = array_values(array_filter($room['signals']['answers'], fn($x) => $x['to'] === $userId && $x['id'] > $since));
    $last = $since;
    foreach ($items as $it) $last = max($last, (int)$it['id']);
    out(['ok' => true, 'items' => $items, 'last_id' => $last]);
}

if ($action === 'send_ice') {
    $targetId = trim((string)getPost('target_id'));
    $candidate = parseMaybeJson(getPost('candidate', ''));
    if ($userId === '' || $targetId === '' || !$candidate) out(['ok' => false, 'error' => 'Missing fields'], 400);
    $id = ++$room['seq']['ice'];
    $room['signals']['ice'][] = ['id' => $id, 'from' => $userId, 'to' => $targetId, 'candidate' => $candidate, 'ts' => now()];
    writeRoom($roomId, $room);
    out(['ok' => true, 'id' => $id]);
}

if ($action === 'get_ice') {
    $since = (int)getPost('since_id', 0);
    $items = array_values(array_filter($room['signals']['ice'], fn($x) => $x['to'] === $userId && $x['id'] > $since));
    $last = $since;
    foreach ($items as $it) $last = max($last, (int)$it['id']);
    out(['ok' => true, 'items' => $items, 'last_id' => $last]);
}

if ($action === 'send_chat') {
    $text = trim((string)getPost('text', ''));
    if ($text === '') out(['ok' => false, 'error' => 'Empty message'], 400);
    $id = ++$room['seq']['chat'];
    $name = $room['users'][$userId]['name'] ?? 'Guest';
    $room['chat'][] = ['id' => $id, 'user_id' => $userId, 'name' => $name, 'text' => mb_substr($text, 0, 500), 'ts' => now()];
    writeRoom($roomId, $room);
    out(['ok' => true, 'id' => $id]);
}

if ($action === 'get_chat') {
    $since = (int)getPost('since_id', 0);
    $items = array_values(array_filter($room['chat'], fn($x) => $x['id'] > $since));
    $last = $since;
    foreach ($items as $it) $last = max($last, (int)$it['id']);
    out(['ok' => true, 'items' => $items, 'last_id' => $last]);
}

if ($action === 'send_command') {
    $type = trim((string)getPost('type', ''));
    $payload = parseMaybeJson(getPost('payload', '{}'));
    if ($type === '') out(['ok' => false, 'error' => 'Missing command type'], 400);

    if (!isset($room['users'][$userId]) || empty($room['users'][$userId]['is_host'])) {
        if ($type !== 'raise_hand') out(['ok' => false, 'error' => 'Host only action'], 403);
    }

    if ($type === 'raise_hand') {
        $raised = !empty($payload['raised']);
        if (isset($room['users'][$userId])) $room['users'][$userId]['hand_raised'] = $raised;
    }

    $target = $payload['target'] ?? null;
    $id = ++$room['seq']['command'];
    $room['commands'][] = ['id' => $id, 'from' => $userId, 'to' => $target, 'type' => $type, 'payload' => $payload, 'ts' => now()];

    if ($type === 'remove_user' && is_string($target) && isset($room['users'][$target])) {
        $room['users'][$target]['last_seen'] = 0;
    }

    writeRoom($roomId, $room);
    out(['ok' => true, 'id' => $id]);
}

if ($action === 'get_commands') {
    $since = (int)getPost('since_id', 0);
    $items = array_values(array_filter($room['commands'], function ($x) use ($since, $userId) {
        if ($x['id'] <= $since) return false;
        if (empty($x['to'])) return false;
        return $x['to'] === $userId;
    }));
    $last = $since;
    foreach ($items as $it) $last = max($last, (int)$it['id']);
    out(['ok' => true, 'items' => $items, 'last_id' => $last]);
}

if ($action === 'leave') {
    if ($userId !== '' && isset($room['users'][$userId])) {
        $wasHost = !empty($room['users'][$userId]['is_host']);
        unset($room['users'][$userId]);
        if ($wasHost && !empty($room['users'])) {
            $newHost = array_key_first($room['users']);
            $room['users'][$newHost]['is_host'] = true;
        }
        writeRoom($roomId, $room);
    }
    out(['ok' => true]);
}

out(['ok' => false, 'error' => 'Unknown action'], 400);
