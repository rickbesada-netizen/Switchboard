// Switchboard engine: runs one messaging account (WhatsApp, Messenger or Instagram) using the
// mautrix bridge connectors, without a Matrix server. Instead of talking to Matrix, the bridge
// talks to our in-process "matrix connector" (connector.go), which streams everything to the
// Switchboard app as JSON lines on stdout. Commands from the app arrive as JSON lines on stdin.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"gopkg.in/yaml.v3"
	_ "go.mau.fi/util/dbutil/litestream"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"
	"maunium.net/go/mautrix/bridgev2/commands"
	"maunium.net/go/mautrix/id"

	metaconnector "go.mau.fi/mautrix-meta/pkg/connector"
	"go.mau.fi/mautrix-meta/pkg/igconnector"
	waconnector "go.mau.fi/mautrix-whatsapp/pkg/connector"
)

var (
	flagNetwork = flag.String("network", "", "whatsapp, messenger or instagram")
	flagData    = flag.String("data", "", "data directory for this account")
	flagMedia   = flag.String("media", "", "shared media directory")
	flagProxy   = flag.String("proxy", "", "proxy URL (http:// or socks5://)")
	flagAccount = flag.String("account", "", "account id, e.g. wa1")
	flagServer  = flag.String("server", "switchboard.local", "fake server name used in IDs")
	flagUser    = flag.String("user", "me", "local user name")
	flagBackfill = flag.Int("backfill", 200, "messages to load per chat on first sync")
)

// ---------------------------------------------------------------- output

var outLock sync.Mutex
var out = bufio.NewWriterSize(os.Stdout, 64*1024)

func emit(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	outLock.Lock()
	out.Write(data)
	out.WriteByte('\n')
	out.Flush()
	outLock.Unlock()
}

// ---------------------------------------------------------------- main

var (
	br     *bridgev2.Bridge
	mx     *Connector
	myMXID id.UserID
	log    zerolog.Logger
)

func main() {
	flag.Parse()
	if *flagNetwork == "" || *flagData == "" || *flagAccount == "" {
		fmt.Fprintln(os.Stderr, "missing -network, -data or -account")
		os.Exit(2)
	}
	if *flagMedia == "" {
		*flagMedia = filepath.Join(*flagData, "media")
	}
	_ = os.MkdirAll(*flagData, 0o700)
	_ = os.MkdirAll(*flagMedia, 0o700)

	log = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true, TimeFormat: time.RFC3339}).
		With().Timestamp().Str("account", *flagAccount).Logger().Level(zerolog.InfoLevel)
	zerolog.DefaultContextLogger = &log
	myMXID = id.NewUserID(*flagUser, *flagServer)

	var network bridgev2.NetworkConnector
	switch *flagNetwork {
	case "whatsapp":
		network = &waconnector.WhatsAppConnector{}
	case "messenger":
		network = &metaconnector.MetaConnector{}
	case "instagram":
		network = &igconnector.IGConnector{}
	default:
		fatal("unknown network " + *flagNetwork)
	}

	// Network config: start from the connector's own example config (its defaults)
	example, netCfg, _ := network.GetConfig()
	if netCfg != nil {
		if err := yaml.Unmarshal([]byte(example), netCfg); err != nil {
			fatal("failed to load network defaults: " + err.Error())
		}
	}

	dbPath := filepath.ToSlash(filepath.Join(*flagData, "bridge.db"))
	db, err := dbutil.NewWithDialect("file:"+dbPath+"?_txlock=immediate", "sqlite3-fk-wal")
	if err != nil {
		fatal("failed to open database: " + err.Error())
	}
	db.Owner = "megabridge/switchboard-" + *flagNetwork
	db.Log = dbutil.ZeroLogger(log.With().Str("component", "db").Logger())

	cfg := &bridgeconfig.BridgeConfig{
		CommandPrefix:                 "!sb",
		PersonalFilteringSpaces:       false,
		PrivateChatPortalMeta:         true,
		BridgeStatusNotices:           "none",
		UnknownErrorAutoReconnect:     30 * time.Second,
		UnknownErrorMaxAutoReconnects: 10,
		BridgeMatrixLeave:             false,
		TagOnlyOnCreate:               true,
		MuteOnlyOnCreate:              true,
		PortalEventBuffer:             64,
		Permissions: bridgeconfig.PermissionConfig{
			"*":            {},
			*flagServer:    {SendEvents: true, Commands: true, Login: true, DoublePuppet: true},
			string(myMXID): {SendEvents: true, Commands: true, Login: true, DoublePuppet: true, Admin: true},
		},
		Backfill: bridgeconfig.BackfillConfig{
			Enabled:              true,
			MaxInitialMessages:   *flagBackfill,
			MaxCatchupMessages:   500,
			UnreadHoursThreshold: 24,
		},
		Proxy: bridgeconfig.ProxyConfig{URL: *flagProxy},
	}

	mx = NewConnector(*flagAccount, *flagServer, *flagData, *flagMedia)
	br = bridgev2.NewBridge("", db, log, cfg, mx, network, commands.NewProcessor)

	ctx := log.WithContext(context.Background())
	if err := br.Start(ctx); err != nil {
		fatal("failed to start: " + err.Error())
	}
	emit(map[string]any{"type": "ready", "user": myMXID, "network": *flagNetwork})
	go statusLoop(ctx)
	readCommands(ctx)
	br.StopWithTimeout(5 * time.Second)
	mx.saveState()
}

func fatal(msg string) {
	emit(map[string]any{"type": "fatal", "error": msg})
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

// Periodically report login states so the app can show "connected" etc.
func statusLoop(ctx context.Context) {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			mx.saveState()
		}
	}
}

// ---------------------------------------------------------------- commands

type command struct {
	ID   int64           `json:"id"`
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args"`
}

func reply(cmdID int64, data any, err error) {
	if err != nil {
		emit(map[string]any{"type": "reply", "id": cmdID, "ok": false, "error": err.Error()})
	} else {
		emit(map[string]any{"type": "reply", "id": cmdID, "ok": true, "data": data})
	}
}

func readCommands(ctx context.Context) {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var c command
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			continue
		}
		if c.Cmd == "quit" {
			reply(c.ID, true, nil)
			return
		}
		go func(c command) {
			defer func() {
				if r := recover(); r != nil {
					reply(c.ID, nil, fmt.Errorf("engine panic: %v", r))
				}
			}()
			data, err := handleCommand(ctx, c.Cmd, c.Args)
			reply(c.ID, data, err)
		}(c)
	}
}
