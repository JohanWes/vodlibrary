#!/bin/bash
# VODlibrary Startup Script for KDE Autostart
cd /home/johanw/repos/VODlibrary

# Log start time
echo "Starting VODlibrary at $(date)" >> server.log

# Start server using npm
npm start >> server.log 2>&1
