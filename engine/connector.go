package main

// An in-process replacement for the bridge's Matrix connector. Everything the bridge would have
// sent to a Matrix homeserver (rooms, messages, edits, deletions, reactions, receipts, typing,
// profiles, media) is emitted to the Switchboard app instead.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

type profile struct {
	Name   string              `json:"name,omitempty"`
	Avatar id.ContentURIString `json:"avatar,omitempty"`
}

type roomState struct {
	Members     map[id.UserID]*event.MemberEventContent `json:"members"`
	PowerLevels *event.PowerLevelsEventContent          `json:"power_levels,omitempty"`
}

type savedState struct {
	Rooms    map[id.RoomID]*roomState `json:"rooms"`
	Profiles map[id.UserID]*profile   `json:"profiles"`
}

type Connector struct {
	br       *bridgev2.Bridge
	account  string
	server   string
	dataDir  string
	mediaDir string

	lock     sync.Mutex
	state    savedState
	dirty    bool
	bot      *Intent
	me       *Intent
	ghostPfx string
}

var _ bridgev2.MatrixConnector = (*Connector)(nil)

func NewConnector(account, server, dataDir, mediaDir string) *Connector {
	c := &Connector{account: account, server: server, dataDir: dataDir, mediaDir: mediaDir}
	c.ghostPfx = "sb" + account + "_"
	c.state.Rooms = map[id.RoomID]*roomState{}
	c.state.Profiles = map[id.UserID]*profile{}
	if data, err := os.ReadFile(filepath.Join(dataDir, "state.json")); err == nil {
		_ = json.Unmarshal(data, &c.state)
		if c.state.Rooms == nil {
			c.state.Rooms = map[id.RoomID]*roomState{}
		}
		if c.state.Profiles == nil {
			c.state.Profiles = map[id.UserID]*profile{}
		}
	}
	c.bot = &Intent{c: c, mxid: id.NewUserID("sb"+account+"bot", server)}
	return c
}

func (c *Connector) saveState() {
	c.lock.Lock()
	if !c.dirty {
		c.lock.Unlock()
		return
	}
	data, err := json.Marshal(&c.state)
	c.dirty = false
	c.lock.Unlock()
	if err != nil {
		return
	}
	tmp := filepath.Join(c.dataDir, "state.json.tmp")
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(c.dataDir, "state.json"))
	}
}

func (c *Connector) room(roomID id.RoomID) *roomState {
	rs := c.state.Rooms[roomID]
	if rs == nil {
		rs = &roomState{Members: map[id.UserID]*event.MemberEventContent{}}
		c.state.Rooms[roomID] = rs
		c.dirty = true
	}
	if rs.Members == nil {
		rs.Members = map[id.UserID]*event.MemberEventContent{}
	}
	return rs
}

func randomID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *Connector) newEventID() id.EventID {
	return id.EventID("$" + randomID(24) + ":" + c.server)
}

// ---------------------------------------------------------------- emitting

func (c *Connector) emitEvent(roomID id.RoomID, evtID id.EventID, evtType event.Type, sender id.UserID, ts time.Time, content any, stateKey *string, redacts id.EventID) {
	raw, err := json.Marshal(content)
	if err != nil {
		raw = []byte("{}")
	}
	if ts.IsZero() {
		ts = time.Now()
	}
	evt := map[string]any{
		"event_id":         evtID,
		"type":             evtType.Type,
		"sender":           sender,
		"origin_server_ts": ts.UnixMilli(),
		"content":          json.RawMessage(raw),
	}
	if stateKey != nil {
		evt["state_key"] = *stateKey
	}
	if redacts != "" {
		evt["redacts"] = redacts
	}
	emit(map[string]any{"type": "event", "room_id": roomID, "event": evt})
}

func (c *Connector) emitMember(roomID id.RoomID, userID id.UserID, content *event.MemberEventContent) {
	sk := userID.String()
	c.emitEvent(roomID, c.newEventID(), event.StateMember, userID, time.Now(), content, &sk, "")
}

// ---------------------------------------------------------------- MatrixConnector

func (c *Connector) Init(br *bridgev2.Bridge) {
	c.br = br
	c.me = &Intent{c: c, mxid: myMXID, doublePuppet: true}
}
func (c *Connector) Start(ctx context.Context) error { return nil }
func (c *Connector) PreStop()                       {}
func (c *Connector) Stop()                          { c.saveState() }
func (c *Connector) BotIntent() bridgev2.MatrixAPI  { return c.bot }

func (c *Connector) GetCapabilities() *bridgev2.MatrixCapabilities {
	return &bridgev2.MatrixCapabilities{AutoJoinInvites: false, BatchSending: false, ArbitraryMemberChange: true, ExtraProfileMeta: false}
}

func (c *Connector) ParseGhostMXID(userID id.UserID) (networkid.UserID, bool) {
	local, server, err := userID.Parse()
	if err != nil || server != c.server || !strings.HasPrefix(local, c.ghostPfx) {
		return "", false
	}
	decoded, err := id.DecodeUserLocalpart(strings.TrimPrefix(local, c.ghostPfx))
	if err != nil {
		return "", false
	}
	return networkid.UserID(decoded), true
}

func (c *Connector) FormatGhostMXID(userID networkid.UserID) id.UserID {
	return id.NewUserID(c.ghostPfx+id.EncodeUserLocalpart(string(userID)), c.server)
}

func (c *Connector) GhostIntent(userID networkid.UserID) bridgev2.MatrixAPI {
	return &Intent{c: c, mxid: c.FormatGhostMXID(userID)}
}

func (c *Connector) NewUserIntent(ctx context.Context, userID id.UserID, accessToken string) (bridgev2.MatrixAPI, string, error) {
	if userID != myMXID {
		return nil, accessToken, nil
	}
	return c.me, "switchboard-local", nil
}

func (c *Connector) SendBridgeStatus(ctx context.Context, state *status.BridgeState) error {
	emit(map[string]any{"type": "bridge_state", "state": state})
	return nil
}

func (c *Connector) SendMessageStatus(ctx context.Context, ms *bridgev2.MessageStatus, evt *bridgev2.MessageStatusEventInfo) {
	if evt == nil || evt.SourceEventID == "" || evt.EventType.IsEphemeral() {
		return
	}
	errText := ms.Message
	if errText == "" && ms.InternalError != nil {
		errText = ms.InternalError.Error()
	}
	emit(map[string]any{
		"type":     "msg_status",
		"room_id":  evt.RoomID,
		"event_id": evt.SourceEventID,
		"status":   ms.Status,
		"reason":   ms.ErrorReason,
		"error":    errText,
	})
}

func (c *Connector) GenerateContentURI(ctx context.Context, mediaID networkid.MediaID) (id.ContentURIString, error) {
	return "", errors.New("direct media is not supported")
}

func (c *Connector) ParseContentURI(ctx context.Context, contentURI id.ContentURIString) (networkid.MediaID, error) {
	return nil, errors.New("direct media is not supported")
}

func (c *Connector) GetPowerLevels(ctx context.Context, roomID id.RoomID) (*event.PowerLevelsEventContent, error) {
	c.lock.Lock()
	defer c.lock.Unlock()
	rs := c.room(roomID)
	if rs.PowerLevels == nil {
		rs.PowerLevels = &event.PowerLevelsEventContent{}
	}
	return rs.PowerLevels, nil
}

func (c *Connector) GetMembers(ctx context.Context, roomID id.RoomID) (map[id.UserID]*event.MemberEventContent, error) {
	c.lock.Lock()
	defer c.lock.Unlock()
	rs := c.room(roomID)
	out := make(map[id.UserID]*event.MemberEventContent, len(rs.Members))
	for k, v := range rs.Members {
		cp := *v
		out[k] = &cp
	}
	return out, nil
}

func (c *Connector) GetMemberInfo(ctx context.Context, roomID id.RoomID, userID id.UserID) (*event.MemberEventContent, error) {
	c.lock.Lock()
	defer c.lock.Unlock()
	m := c.room(roomID).Members[userID]
	if m == nil {
		return nil, nil
	}
	cp := *m
	return &cp, nil
}

func (c *Connector) BatchSend(ctx context.Context, roomID id.RoomID, req *mautrix.ReqBeeperBatchSend, extras []*bridgev2.MatrixSendExtra) (*mautrix.RespBeeperBatchSend, error) {
	resp := &mautrix.RespBeeperBatchSend{EventIDs: make([]id.EventID, len(req.Events))}
	for i, evt := range req.Events {
		evtID := evt.ID
		if evtID == "" {
			evtID = c.newEventID()
		}
		c.emitEvent(roomID, evtID, evt.Type, evt.Sender, time.UnixMilli(evt.Timestamp), &evt.Content, evt.StateKey, evt.Redacts)
		resp.EventIDs[i] = evtID
	}
	return resp, nil
}

func (c *Connector) GenerateDeterministicRoomID(key networkid.PortalKey) id.RoomID {
	h := sha256.Sum256([]byte(string(key.ID) + "\x00" + string(key.Receiver)))
	return id.RoomID(fmt.Sprintf("!%s_%s:%s", c.account, hex.EncodeToString(h[:12]), c.server))
}

func (c *Connector) GenerateDeterministicEventID(roomID id.RoomID, _ networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID) id.EventID {
	h := sha256.Sum256([]byte(string(roomID) + "\x00" + string(messageID) + "\x00" + string(partID)))
	return id.EventID("$" + base64.RawURLEncoding.EncodeToString(h[:]) + ":" + c.server)
}

func (c *Connector) GenerateReactionEventID(roomID id.RoomID, targetMessage *database.Message, sender networkid.UserID, emojiID networkid.EmojiID) id.EventID {
	return c.newEventID()
}

func (c *Connector) ServerName() string { return c.server }

// ---------------------------------------------------------------- media store

type mediaMeta struct {
	Mime string `json:"mime"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func (c *Connector) mediaPath(mediaID string) string {
	return filepath.Join(c.mediaDir, mediaID)
}

func (c *Connector) newMediaID() string {
	return c.account + "-" + strings.ReplaceAll(randomID(18), "_", "x")
}

func (c *Connector) writeMeta(mediaID string, meta mediaMeta) {
	data, _ := json.Marshal(meta)
	_ = os.WriteFile(c.mediaPath(mediaID)+".json", data, 0o600)
}

func (c *Connector) mediaURI(mediaID string) id.ContentURIString {
	return id.ContentURIString("mxc://" + c.server + "/" + mediaID)
}

func (c *Connector) parseMediaURI(uri id.ContentURIString) (string, error) {
	parsed, err := uri.Parse()
	if err != nil {
		return "", err
	}
	if strings.ContainsAny(parsed.FileID, `/\.`) {
		return "", errors.New("invalid media id")
	}
	return parsed.FileID, nil
}

func (c *Connector) storeMedia(data []byte, name, mime string) (id.ContentURIString, error) {
	mid := c.newMediaID()
	if err := os.WriteFile(c.mediaPath(mid), data, 0o600); err != nil {
		return "", err
	}
	c.writeMeta(mid, mediaMeta{Mime: mime, Name: name, Size: int64(len(data))})
	return c.mediaURI(mid), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	outF, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(outF, in)
	if cerr := outF.Close(); err == nil {
		err = cerr
	}
	return err
}

// ---------------------------------------------------------------- Intent (MatrixAPI)

type Intent struct {
	c            *Connector
	mxid         id.UserID
	doublePuppet bool
}

var _ bridgev2.MatrixAPI = (*Intent)(nil)

func (in *Intent) GetMXID() id.UserID  { return in.mxid }
func (in *Intent) IsDoublePuppet() bool { return in.doublePuppet }

func (in *Intent) SendMessage(ctx context.Context, roomID id.RoomID, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
	evtID := in.c.newEventID()
	var ts time.Time
	if extra != nil {
		ts = extra.Timestamp
	}
	var redacts id.EventID
	if eventType == event.EventRedaction {
		if rc, ok := content.Parsed.(*event.RedactionEventContent); ok {
			redacts = rc.Redacts
		}
	}
	if eventType == event.EventMessage {
		if mc, ok := content.Parsed.(*event.MessageEventContent); ok {
			mc.RemovePerMessageProfileFallback()
		}
	}
	in.c.emitEvent(roomID, evtID, eventType, in.mxid, ts, content, nil, redacts)
	return &mautrix.RespSendEvent{EventID: evtID}, nil
}

func (in *Intent) fillMember(roomID id.RoomID, userID id.UserID, mc *event.MemberEventContent) {
	if mc.Displayname != "" || mc.AvatarURL != "" {
		return
	}
	if old := in.c.room(roomID).Members[userID]; old != nil {
		mc.Displayname, mc.AvatarURL = old.Displayname, old.AvatarURL
		return
	}
	if p := in.c.state.Profiles[userID]; p != nil {
		mc.Displayname, mc.AvatarURL = p.Name, p.Avatar
	}
}

func (in *Intent) SendState(ctx context.Context, roomID id.RoomID, eventType event.Type, stateKey string, content *event.Content, ts time.Time) (*mautrix.RespSendEvent, error) {
	in.c.lock.Lock()
	switch eventType {
	case event.StateMember:
		if mc, ok := content.Parsed.(*event.MemberEventContent); ok {
			in.fillMember(roomID, id.UserID(stateKey), mc)
			cp := *mc
			in.c.room(roomID).Members[id.UserID(stateKey)] = &cp
			in.c.dirty = true
		}
	case event.StatePowerLevels:
		if pl, ok := content.Parsed.(*event.PowerLevelsEventContent); ok {
			in.c.room(roomID).PowerLevels = pl
			in.c.dirty = true
		}
	}
	in.c.lock.Unlock()
	evtID := in.c.newEventID()
	in.c.emitEvent(roomID, evtID, eventType, in.mxid, ts, content, &stateKey, "")
	return &mautrix.RespSendEvent{EventID: evtID}, nil
}

func (in *Intent) MarkRead(ctx context.Context, roomID id.RoomID, eventID id.EventID, ts time.Time) error {
	if ts.IsZero() {
		ts = time.Now()
	}
	emit(map[string]any{"type": "receipt", "room_id": roomID, "event_id": eventID, "user_id": in.mxid, "ts": ts.UnixMilli()})
	return nil
}

func (in *Intent) MarkUnread(ctx context.Context, roomID id.RoomID, unread bool) error {
	if in.doublePuppet {
		emit(map[string]any{"type": "mark_unread", "room_id": roomID, "unread": unread})
	}
	return nil
}

func (in *Intent) MarkTyping(ctx context.Context, roomID id.RoomID, typingType bridgev2.TypingType, timeout time.Duration) error {
	emit(map[string]any{"type": "typing", "room_id": roomID, "user_id": in.mxid, "typing": timeout > 0, "timeout_ms": timeout.Milliseconds()})
	return nil
}

func (in *Intent) DownloadMedia(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo) ([]byte, error) {
	if file != nil && file.URL != "" {
		uri = file.URL
	}
	mid, err := in.c.parseMediaURI(uri)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(in.c.mediaPath(mid))
}

func (in *Intent) DownloadMediaToFile(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo, writable bool, callback func(*os.File) error) error {
	if file != nil && file.URL != "" {
		uri = file.URL
	}
	mid, err := in.c.parseMediaURI(uri)
	if err != nil {
		return err
	}
	path := in.c.mediaPath(mid)
	if writable {
		tmp, err := os.CreateTemp("", "sb-media-*")
		if err != nil {
			return err
		}
		tmpName := tmp.Name()
		_ = tmp.Close()
		defer os.Remove(tmpName)
		if err = copyFile(path, tmpName); err != nil {
			return err
		}
		path = tmpName
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		f, err = os.Open(path)
		if err != nil {
			return err
		}
	}
	defer f.Close()
	if err = callback(f); err != nil {
		return bridgev2.CallbackError{Type: "read", Wrapped: err}
	}
	return nil
}

func (in *Intent) UploadMedia(ctx context.Context, roomID id.RoomID, data []byte, fileName, mimeType string) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	uri, err := in.c.storeMedia(data, fileName, mimeType)
	return uri, nil, err
}

func (in *Intent) UploadMediaStream(ctx context.Context, roomID id.RoomID, size int64, requireFile bool, cb bridgev2.FileStreamCallback) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	mid := in.c.newMediaID()
	final := in.c.mediaPath(mid)
	tmp, err := os.CreateTemp(in.c.mediaDir, "upload-*")
	if err != nil {
		return "", nil, err
	}
	tmpName := tmp.Name()
	res, err := cb(tmp)
	_ = tmp.Close()
	if err != nil {
		_ = os.Remove(tmpName)
		return "", nil, bridgev2.CallbackError{Type: "write", Wrapped: err}
	}
	if res.ReplacementFile != "" && res.ReplacementFile != tmpName {
		_ = os.Remove(tmpName)
		if err = copyFile(res.ReplacementFile, final); err != nil {
			return "", nil, err
		}
	} else if err = os.Rename(tmpName, final); err != nil {
		if err = copyFile(tmpName, final); err != nil {
			return "", nil, err
		}
		_ = os.Remove(tmpName)
	}
	var sz int64
	if st, err := os.Stat(final); err == nil {
		sz = st.Size()
	}
	in.c.writeMeta(mid, mediaMeta{Mime: res.MimeType, Name: res.FileName, Size: sz})
	return in.c.mediaURI(mid), nil, nil
}

func (in *Intent) updateProfile(apply func(p *profile)) {
	in.c.lock.Lock()
	p := in.c.state.Profiles[in.mxid]
	if p == nil {
		p = &profile{}
		in.c.state.Profiles[in.mxid] = p
	}
	apply(p)
	in.c.dirty = true
	type upd struct {
		room id.RoomID
		mc   event.MemberEventContent
	}
	var updates []upd
	for roomID, rs := range in.c.state.Rooms {
		if m := rs.Members[in.mxid]; m != nil && m.Membership == event.MembershipJoin {
			m.Displayname, m.AvatarURL = p.Name, p.Avatar
			updates = append(updates, upd{roomID, *m})
		}
	}
	in.c.lock.Unlock()
	for _, u := range updates {
		mc := u.mc
		in.c.emitMember(u.room, in.mxid, &mc)
	}
}

func (in *Intent) SetDisplayName(ctx context.Context, name string) error {
	in.updateProfile(func(p *profile) { p.Name = name })
	return nil
}

func (in *Intent) SetAvatarURL(ctx context.Context, avatarURL id.ContentURIString) error {
	in.updateProfile(func(p *profile) { p.Avatar = avatarURL })
	return nil
}

func (in *Intent) SetExtraProfileMeta(ctx context.Context, data any) error { return nil }
func (in *Intent) SetProfile(ctx context.Context, data any) error          { return nil }

func (in *Intent) CreateRoom(ctx context.Context, req *mautrix.ReqCreateRoom) (id.RoomID, error) {
	roomID := req.BeeperLocalRoomID
	if roomID == "" {
		roomID = id.RoomID(fmt.Sprintf("!%s_%s:%s", in.c.account, strings.ReplaceAll(randomID(12), "_", "x"), in.c.server))
	}
	in.c.lock.Lock()
	rs := in.c.room(roomID)
	if req.PowerLevelOverride != nil {
		rs.PowerLevels = req.PowerLevelOverride
	}
	rs.Members[in.mxid] = &event.MemberEventContent{Membership: event.MembershipJoin}
	in.c.dirty = true
	in.c.lock.Unlock()

	empty := ""
	createContent := map[string]any{"creator": in.mxid}
	for k, v := range req.CreationContent {
		createContent[k] = v
	}
	if req.IsDirect {
		createContent["is_direct"] = true
	}
	in.c.emitEvent(roomID, in.c.newEventID(), event.StateCreate, in.mxid, time.Now(), createContent, &empty, "")
	if req.Name != "" {
		in.c.emitEvent(roomID, in.c.newEventID(), event.StateRoomName, in.mxid, time.Now(), &event.RoomNameEventContent{Name: req.Name}, &empty, "")
	}
	if req.Topic != "" {
		in.c.emitEvent(roomID, in.c.newEventID(), event.StateTopic, in.mxid, time.Now(), &event.TopicEventContent{Topic: req.Topic}, &empty, "")
	}
	for _, st := range req.InitialState {
		sk := ""
		if st.StateKey != nil {
			sk = *st.StateKey
		}
		in.c.emitEvent(roomID, in.c.newEventID(), st.Type, in.mxid, time.Now(), &st.Content, &sk, "")
	}
	for _, uid := range req.Invite {
		in.c.lock.Lock()
		in.c.room(roomID).Members[uid] = &event.MemberEventContent{Membership: event.MembershipInvite}
		in.c.lock.Unlock()
	}
	return roomID, nil
}

func (in *Intent) DeleteRoom(ctx context.Context, roomID id.RoomID, puppetsOnly bool) error {
	in.c.lock.Lock()
	delete(in.c.state.Rooms, roomID)
	in.c.dirty = true
	in.c.lock.Unlock()
	emit(map[string]any{"type": "room_deleted", "room_id": roomID})
	return nil
}

func (in *Intent) EnsureJoined(ctx context.Context, roomID id.RoomID, params ...bridgev2.EnsureJoinedParams) error {
	in.c.lock.Lock()
	rs := in.c.room(roomID)
	if m := rs.Members[in.mxid]; m != nil && m.Membership == event.MembershipJoin {
		in.c.lock.Unlock()
		return nil
	}
	mc := &event.MemberEventContent{Membership: event.MembershipJoin}
	in.fillMember(roomID, in.mxid, mc)
	cp := *mc
	rs.Members[in.mxid] = &cp
	in.c.dirty = true
	in.c.lock.Unlock()
	in.c.emitMember(roomID, in.mxid, mc)
	return nil
}

func (in *Intent) EnsureInvited(ctx context.Context, roomID id.RoomID, userID id.UserID) error {
	in.c.lock.Lock()
	rs := in.c.room(roomID)
	if m := rs.Members[userID]; m != nil && (m.Membership == event.MembershipJoin || m.Membership == event.MembershipInvite) {
		in.c.lock.Unlock()
		return nil
	}
	rs.Members[userID] = &event.MemberEventContent{Membership: event.MembershipInvite}
	in.c.dirty = true
	in.c.lock.Unlock()
	// Our own user "accepts" immediately: there's no separate invite step in Switchboard
	if userID == myMXID {
		return in.c.me.EnsureJoined(ctx, roomID)
	}
	return nil
}

func (in *Intent) TagRoom(ctx context.Context, roomID id.RoomID, tag event.RoomTag, isTagged bool) error {
	emit(map[string]any{"type": "room_tag", "room_id": roomID, "tag": tag, "tagged": isTagged})
	return nil
}

func (in *Intent) MuteRoom(ctx context.Context, roomID id.RoomID, until time.Time) error {
	emit(map[string]any{"type": "room_mute", "room_id": roomID, "until": until.UnixMilli()})
	return nil
}

func (in *Intent) GetEvent(ctx context.Context, roomID id.RoomID, eventID id.EventID) (*event.Event, error) {
	return nil, mautrix.MNotFound.WithMessage("event not available")
}
