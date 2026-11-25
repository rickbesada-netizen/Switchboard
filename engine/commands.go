package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

type activeLogin struct {
	proc   bridgev2.LoginProcess
	ctx    context.Context
	cancel context.CancelFunc
	lock   sync.Mutex
}

var (
	loginsLock sync.Mutex
	logins     = map[string]*activeLogin{}
)

func stepOut(loginID string, step *bridgev2.LoginStep) (map[string]any, error) {
	data, err := json.Marshal(step)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	_ = json.Unmarshal(data, &out)
	out["login_id"] = loginID
	if step.Type == bridgev2.LoginStepTypeComplete {
		loginsLock.Lock()
		if l := logins[loginID]; l != nil {
			l.cancel()
			delete(logins, loginID)
		}
		loginsLock.Unlock()
	}
	return out, nil
}

func me(ctx context.Context) (*bridgev2.User, error) {
	u, err := br.GetUserByMXID(ctx, myMXID)
	if err != nil {
		return nil, err
	} else if u == nil {
		return nil, errors.New("local user not found")
	}
	return u, nil
}

func eventTypeFor(t string) event.Type {
	switch t {
	case "m.room.message":
		return event.EventMessage
	case "m.reaction":
		return event.EventReaction
	case "m.room.redaction":
		return event.EventRedaction
	case "m.sticker":
		return event.EventSticker
	default:
		return event.Type{Type: t, Class: event.MessageEventType}
	}
}

// Send an event as the local user: show it in the app immediately, then hand it to the bridge
func sendAsMe(ctx context.Context, roomID id.RoomID, evtType event.Type, rawContent json.RawMessage) (id.EventID, error) {
	evt := &event.Event{
		Sender:    myMXID,
		Type:      evtType,
		RoomID:    roomID,
		ID:        mx.newEventID(),
		Timestamp: time.Now().UnixMilli(),
	}
	if err := json.Unmarshal(rawContent, &evt.Content); err != nil {
		return "", fmt.Errorf("bad content: %w", err)
	}
	if err := evt.Content.ParseRaw(evtType); err != nil && !errors.Is(err, event.ErrContentAlreadyParsed) {
		return "", fmt.Errorf("bad content: %w", err)
	}
	if evtType == event.EventRedaction {
		if rc, ok := evt.Content.Parsed.(*event.RedactionEventContent); ok {
			evt.Redacts = rc.Redacts
		}
	}
	mx.emitEvent(roomID, evt.ID, evtType, myMXID, time.UnixMilli(evt.Timestamp), json.RawMessage(rawContent), nil, evt.Redacts)
	res := br.QueueMatrixEvent(ctx, evt)
	if !res.Success && !res.Queued && !res.Ignored && res.Error != nil {
		return evt.ID, res.Error
	}
	return evt.ID, nil
}

func handleCommand(ctx context.Context, cmd string, rawArgs json.RawMessage) (any, error) {
	var a map[string]any
	_ = json.Unmarshal(rawArgs, &a)
	str := func(k string) string {
		if v, ok := a[k].(string); ok {
			return v
		}
		return ""
	}

	switch cmd {
	case "ping":
		return "pong", nil

	case "whoami":
		u, err := me(ctx)
		if err != nil {
			return nil, err
		}
		var out []map[string]any
		for _, ul := range u.GetUserLogins() {
			out = append(out, map[string]any{"id": ul.ID, "name": ul.RemoteName, "profile": ul.RemoteProfile})
		}
		return map[string]any{"logins": out, "network": *flagNetwork}, nil

	case "login_flows":
		return map[string]any{"flows": br.Network.GetLoginFlows()}, nil

	case "login_start":
		u, err := me(ctx)
		if err != nil {
			return nil, err
		}
		lctx, cancel := context.WithTimeout(log.WithContext(br.BackgroundCtx), 30*time.Minute)
		proc, err := br.Network.CreateLogin(lctx, u, str("flow_id"))
		if err != nil {
			cancel()
			return nil, err
		}
		override := u.GetDefaultLogin()
		var step *bridgev2.LoginStep
		if p, ok := proc.(bridgev2.LoginProcessWithParams); ok {
			step, err = p.StartWithParams(lctx, bridgev2.LoginStartParams{Override: override})
		} else if p, ok := proc.(bridgev2.LoginProcessWithOverride); ok && override != nil {
			step, err = p.StartWithOverride(lctx, override)
		} else {
			step, err = proc.Start(lctx)
		}
		if err != nil {
			cancel()
			proc.Cancel()
			return nil, err
		}
		loginID := randomID(12)
		loginsLock.Lock()
		logins[loginID] = &activeLogin{proc: proc, ctx: lctx, cancel: cancel}
		loginsLock.Unlock()
		return stepOut(loginID, step)

	case "login_step":
		loginID := str("login_id")
		loginsLock.Lock()
		l := logins[loginID]
		loginsLock.Unlock()
		if l == nil {
			return nil, errors.New("login process not found (it may have expired); start again")
		}
		l.lock.Lock()
		defer l.lock.Unlock()
		input := map[string]string{}
		if d, ok := a["data"].(map[string]any); ok {
			for k, v := range d {
				input[k] = fmt.Sprint(v)
			}
		}
		var step *bridgev2.LoginStep
		var err error
		switch bridgev2.LoginStepType(str("step_type")) {
		case bridgev2.LoginStepTypeDisplayAndWait:
			p, ok := l.proc.(bridgev2.LoginProcessDisplayAndWait)
			if !ok {
				return nil, errors.New("login process doesn't support waiting")
			}
			step, err = p.Wait(l.ctx)
		case bridgev2.LoginStepTypeCookies:
			p, ok := l.proc.(bridgev2.LoginProcessCookies)
			if !ok {
				return nil, errors.New("login process doesn't accept cookies")
			}
			step, err = p.SubmitCookies(l.ctx, input)
		case bridgev2.LoginStepTypeUserInput:
			p, ok := l.proc.(bridgev2.LoginProcessUserInput)
			if !ok {
				return nil, errors.New("login process doesn't accept input")
			}
			step, err = p.SubmitUserInput(l.ctx, input)
		default:
			return nil, fmt.Errorf("unsupported step type %q", str("step_type"))
		}
		if err != nil {
			return nil, err
		}
		return stepOut(loginID, step)

	case "login_cancel":
		loginsLock.Lock()
		if l := logins[str("login_id")]; l != nil {
			l.proc.Cancel()
			l.cancel()
			delete(logins, str("login_id"))
		}
		loginsLock.Unlock()
		return true, nil

	case "logout":
		u, err := me(ctx)
		if err != nil {
			return nil, err
		}
		for _, ul := range u.GetUserLogins() {
			if str("login_id") == "" || string(ul.ID) == str("login_id") {
				ul.Logout(ctx)
			}
		}
		return true, nil

	case "send":
		raw, _ := json.Marshal(a["content"])
		evtID, err := sendAsMe(ctx, id.RoomID(str("room_id")), eventTypeFor(str("event_type")), raw)
		return map[string]any{"event_id": evtID}, err

	case "send_file":
		path := str("path")
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(path)
		mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
		if mt == "" {
			mt = "application/octet-stream"
		}
		if i := strings.Index(mt, ";"); i > 0 {
			mt = mt[:i]
		}
		uri, err := mx.storeMedia(data, name, mt)
		if err != nil {
			return nil, err
		}
		msgType := event.MsgFile
		switch {
		case strings.HasPrefix(mt, "image/"):
			msgType = event.MsgImage
		case strings.HasPrefix(mt, "video/"):
			msgType = event.MsgVideo
		case strings.HasPrefix(mt, "audio/"):
			msgType = event.MsgAudio
		}
		info := map[string]any{"mimetype": mt, "size": len(data)}
		if msgType == event.MsgImage {
			if f, err := os.Open(path); err == nil {
				if cfg, _, err := image.DecodeConfig(f); err == nil {
					info["w"], info["h"] = cfg.Width, cfg.Height
				}
				f.Close()
			}
		}
		body := str("caption")
		content := map[string]any{"msgtype": msgType, "body": name, "filename": name, "url": uri, "info": info}
		if body != "" {
			content["body"] = body
		}
		raw, _ := json.Marshal(content)
		evtID, err := sendAsMe(ctx, id.RoomID(str("room_id")), event.EventMessage, raw)
		return map[string]any{"event_id": evtID}, err

	case "receipt":
		roomID := id.RoomID(str("room_id"))
		evtID := id.EventID(str("event_id"))
		evt := &event.Event{
			Type:   event.EphemeralEventReceipt,
			RoomID: roomID,
			Content: event.Content{Parsed: &event.ReceiptEventContent{
				evtID: {event.ReceiptTypeRead: {myMXID: {Timestamp: time.Now()}}},
			}},
		}
		br.QueueMatrixEvent(ctx, evt)
		return true, nil

	case "typing":
		roomID := id.RoomID(str("room_id"))
		users := []id.UserID{}
		if t, _ := a["typing"].(bool); t {
			users = append(users, myMXID)
		}
		br.QueueMatrixEvent(ctx, &event.Event{
			Type:    event.EphemeralEventTyping,
			RoomID:  roomID,
			Content: event.Content{Parsed: &event.TypingEventContent{UserIDs: users}},
		})
		return true, nil

	case "media_path":
		mid, err := mx.parseMediaURI(id.ContentURIString(str("uri")))
		if err != nil {
			return nil, err
		}
		return map[string]any{"path": mx.mediaPath(mid)}, nil

	case "ghost_id":
		return mx.FormatGhostMXID(networkid.UserID(str("remote_id"))), nil
	}
	return nil, fmt.Errorf("unknown command %q", cmd)
}
