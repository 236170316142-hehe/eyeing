# ============================================================================
#  ADVANCED MULTI-PC DEPLOYMENT VIA POWERSHELL
#  Features: Remote deployment, logging, validation, batch operations
# ============================================================================

param(
    [string]$ComputerList = "",
    [string]$Username = "",
    [string]$Password = "",
    [string]$SourceFolder = $PSScriptRoot,
    [string]$TargetFolder = "C:\EmployeeMonitor",
    [switch]$RemoteDeploy = $false,
    [switch]$Validate = $false
)

$ErrorActionPreference = "Continue"
$WarningPreference = "Continue"

# ============================================================================
#  FUNCTIONS
# ============================================================================

function Write-StatusMessage {
    param([string]$Message, [string]$Status = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $color = @{
        "INFO"    = "Cyan"
        "SUCCESS" = "Green"
        "WARNING" = "Yellow"
        "ERROR"   = "Red"
        "STEP"    = "Magenta"
    }[$Status]
    
    Write-Host "[$timestamp] [$Status] $Message" -ForegroundColor $color
}

function Test-Tesseract {
    param([string]$ComputerName = "localhost")
    
    Write-StatusMessage "Testing Tesseract on $ComputerName..." "INFO"
    
    $testScript = @"
python verify_tesseract.py 2>&1
`$EXIT_CODE = `$LASTEXITCODE
exit `$EXIT_CODE
"@
    
    if ($ComputerName -eq "localhost" -or $ComputerName -eq $env:COMPUTERNAME) {
        & cmd /c $testScript | Out-Null
    } else {
        Invoke-Command -ComputerName $ComputerName -ScriptBlock {
            param($SourcePath)
            Push-Location $SourcePath
            & python verify_tesseract.py 2>&1 | Out-Null
            Pop-Location
        } -ArgumentList "$TargetFolder" 2>$null
    }
    
    $result = $LASTEXITCODE -eq 0
    if ($result) {
        Write-StatusMessage "Tesseract test PASSED on $ComputerName" "SUCCESS"
    } else {
        Write-StatusMessage "Tesseract test FAILED on $ComputerName" "WARNING"
    }
    
    return $result
}

function Test-Autostart {
    param([string]$ComputerName = "localhost")
    
    Write-StatusMessage "Testing Autostart on $ComputerName..." "INFO"
    
    $testScript = @"
python verify_autostart.py 2>&1
`$EXIT_CODE = `$LASTEXITCODE
exit `$EXIT_CODE
"@
    
    if ($ComputerName -eq "localhost" -or $ComputerName -eq $env:COMPUTERNAME) {
        & cmd /c $testScript | Out-Null
    } else {
        Invoke-Command -ComputerName $ComputerName -ScriptBlock {
            param($SourcePath)
            Push-Location $SourcePath
            & python verify_autostart.py 2>&1 | Out-Null
            Pop-Location
        } -ArgumentList "$TargetFolder" 2>$null
    }
    
    $result = $LASTEXITCODE -eq 0
    if ($result) {
        Write-StatusMessage "Autostart test PASSED on $ComputerName" "SUCCESS"
    } else {
        Write-StatusMessage "Autostart test FAILED on $ComputerName" "WARNING"
    }
    
    return $result
}

function Deploy-ToComputer {
    param(
        [string]$ComputerName,
        [string]$Username = "",
        [string]$Password = ""
    )
    
    Write-StatusMessage "Starting deployment to $ComputerName" "STEP"
    
    $targetPath = "\\$ComputerName\c$\EmployeeMonitor"
    
    # Create credentials if provided
    $credential = $null
    if ($Username -and $Password) {
        $secPassword = ConvertTo-SecureString $Password -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential($Username, $secPassword)
    }
    
    try {
        # Copy files
        Write-StatusMessage "Copying files to $ComputerName..." "INFO"
        
        if (!(Test-Path $targetPath)) {
            New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        }
        
        $params = @{
            Path        = "$SourceFolder\*"
            Destination = $targetPath
            Recurse     = $true
            Force       = $true
        }
        
        if ($credential) {
            Copy-Item @params -ErrorAction SilentlyContinue
        } else {
            Copy-Item @params
        }
        
        Write-StatusMessage "Files copied to $ComputerName" "SUCCESS"
        
        # Run installer remotely
        Write-StatusMessage "Running installer on $ComputerName..." "INFO"
        
        $installScript = @"
cd C:\EmployeeMonitor
deploy_automated.bat
"@
        
        if ($credential) {
            Invoke-Command -ComputerName $ComputerName -ScriptBlock {
                & cmd /c "cd C:\EmployeeMonitor && deploy_automated.bat"
            } -Credential $credential 2>$null
        } else {
            Invoke-Command -ComputerName $ComputerName -ScriptBlock {
                & cmd /c "cd C:\EmployeeMonitor && deploy_automated.bat"
            } 2>$null
        }
        
        Write-StatusMessage "Installer completed on $ComputerName" "SUCCESS"
        
        # Validate
        if ($Validate) {
            Start-Sleep -Seconds 5
            Test-Tesseract -ComputerName $ComputerName
            Test-Autostart -ComputerName $ComputerName
        }
        
        return $true
        
    } catch {
        Write-StatusMessage "Deployment to $ComputerName FAILED: $_" "ERROR"
        return $false
    }
}

function Read-ComputerList {
    Write-StatusMessage "Enter computer names to deploy to (one per line, empty line when done):" "INFO"
    $computers = @()
    
    while ($true) {
        $computer = Read-Host "Computer name or IP"
        if ([string]::IsNullOrWhiteSpace($computer)) {
            break
        }
        $computers += $computer.Trim()
    }
    
    return $computers
}

# ============================================================================
#  MAIN MENU
# ============================================================================

function Show-Menu {
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Cyan
    Write-Host "  ADVANCED MULTI-PC DEPLOYMENT TOOL" -ForegroundColor Cyan
    Write-Host "============================================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. Deploy to current computer (localhost)"
    Write-Host "2. Deploy to multiple computers (remote)"
    Write-Host "3. Validate existing installation on computer"
    Write-Host "4. Test Tesseract on computer"
    Write-Host "5. Test Autostart on computer"
    Write-Host "6. Generate deployment report"
    Write-Host "7. Exit"
    Write-Host ""
}

# ============================================================================
#  EXECUTION
# ============================================================================

$logFile = Join-Path $PSScriptRoot "deployment_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

Write-StatusMessage "Deployment tool started" "INFO"
Write-StatusMessage "Log file: $logFile" "INFO"

while ($true) {
    Show-Menu
    $choice = Read-Host "Select option"
    
    switch ($choice) {
        "1" {
            Write-StatusMessage "Deploying to localhost..." "STEP"
            Push-Location $SourceFolder
            & cmd /c "deploy_automated.bat"
            Pop-Location
            break
        }
        "2" {
            Write-StatusMessage "Remote multi-computer deployment" "STEP"
            $computers = Read-ComputerList
            
            if ($computers.Count -gt 0) {
                Write-StatusMessage "Deploying to $($computers.Count) computer(s)" "INFO"
                
                $username = Read-Host "Username (press Enter for current user)"
                $password = Read-Host "Password (press Enter for no authentication)" -AsSecureString
                
                foreach ($computer in $computers) {
                    Deploy-ToComputer -ComputerName $computer `
                        -Username $username `
                        -Password ([System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($password)))
                }
            }
            break
        }
        "3" {
            $computer = Read-Host "Computer name or IP"
            Write-StatusMessage "Validating installation on $computer" "STEP"
            Test-Tesseract -ComputerName $computer
            Test-Autostart -ComputerName $computer
            break
        }
        "4" {
            $computer = Read-Host "Computer name or IP"
            Write-StatusMessage "Testing Tesseract on $computer" "STEP"
            Test-Tesseract -ComputerName $computer
            break
        }
        "5" {
            $computer = Read-Host "Computer name or IP"
            Write-StatusMessage "Testing Autostart on $computer" "STEP"
            Test-Autostart -ComputerName $computer
            break
        }
        "6" {
            Write-StatusMessage "Generating deployment report..." "STEP"
            Get-Content $logFile | Out-Host
            break
        }
        "7" {
            Write-StatusMessage "Exiting deployment tool" "INFO"
            exit 0
        }
        default {
            Write-Host "Invalid selection" -ForegroundColor Red
        }
    }
    
    Write-Host ""
    Read-Host "Press Enter to continue"
    Clear-Host
}
