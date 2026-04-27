#!/bin/sh
set -e

echo "--- Installing Node dependencies ---"
cd $CI_PRIMARY_REPOSITORY_PATH/frontend
npm install

echo "--- Installing CocoaPods ---"
cd ios
pod install
