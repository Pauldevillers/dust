#!/bin/bash

# Default to safe mode
SAFE_MODE=1

# Ensure NODE_ENV is not set to production.
if [ "$NODE_ENV" == "production" ]; then
    echo "Error: This script is not meant to be run in a production environment. Aborting."
    exit 1
fi

BRANCH_NAME=main

# Check environment variable to allow unsafe operations
if [[ $ALLOW_UNSAFE_INITDB == "true" ]]; then
    SAFE_MODE=0
fi

# Parse command line arguments for '--unsafe' flag
for arg in "$@"
do
    if [[ $arg == "--unsafe" ]]; then
        SAFE_MODE=0
        break
    fi
done

# If in safe mode, ensure the repository is on the main branch and up-to-date
if [[ $SAFE_MODE -eq 1 ]]; then
    # Check if on main branch
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [[ $CURRENT_BRANCH != "$BRANCH_NAME" ]]; then
        echo "Error: Not on main branch. Aborting."
        exit 1
    fi

    # Check if local is up-to-date with remote main
    git fetch origin "$BRANCH_NAME" && git diff --exit-code "origin/$BRANCH_NAME" > /dev/null
    if [ $? -ne 0 ]; then
        echo "Error: Local branch is not up-to-date with remote "$BRANCH_NAME". Aborting. You need to either align with origin/$BRANCH_NAME or stash your local changes (git stash)."
        git diff --quiet || echo "You have a dirty directory. Please stash or reset your changes before running this script."
        git diff --cached --quiet || echo "You have staged changes. Make sure to be aligned with  origin/$BRANCH_NAME before running this script."
        exit 1
    else
        echo "Local branch is up-to-date with remote "$BRANCH_NAME". Will proceed."
    fi
fi


echo "Running initdb"
# Database initialization procedures go here

npx tsx admin/db.ts

