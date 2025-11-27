#!/bin/bash

# Check if a commit message is provided
if [ -z "$1" ]; then
    echo "You forgot the commit message, genius."
    exit 1
fi

# Add all changes
git add .

# Commit changes with the provided message
git commit -m "$1"

# Push changes to the master branch on origin
git push origin master
